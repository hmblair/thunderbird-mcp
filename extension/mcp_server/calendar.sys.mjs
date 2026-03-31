// calendar.sys.mjs — Calendar tools: list, create, update, delete events

export function createCalendarHandlers({ cal, CalEvent, ChromeUtils, utils }) {
  const { mcpWarn, mcpDebug, parseDate, formatCalDateTime, findWritableCalendar, resolveCalendar, calendarPath, shortId } = utils;

  function listCalendars() {
    if (!cal) {
      return { error: "Calendar not available" };
    }
    try {
      return cal.manager.getCalendars().map(c => ({
        calendar: calendarPath(c),
        type: c.type,
        readOnly: c.readOnly
      }));
    } catch (e) {
      return { error: e.toString() };
    }
  }

  async function getCalendarItems(calendar, rangeStart, rangeEnd) {
    const FILTER_EVENT = 1 << 3;
    if (typeof calendar.getItemsAsArray === "function") {
      return await calendar.getItemsAsArray(FILTER_EVENT, 0, rangeStart, rangeEnd);
    }
    const items = [];
    const stream = cal.iterate.streamValues(calendar.getItems(FILTER_EVENT, 0, rangeStart, rangeEnd));
    for await (const chunk of stream) {
      for (const i of chunk) items.push(i);
    }
    return items;
  }

  function resolveEventId(input, items) {
    if (!input || typeof input !== "string") return null;
    // Try direct match first
    const direct = items.find(i => i.id === input);
    if (direct) return direct;
    // Try short ID match
    for (const item of items) {
      if (shortId(item.id) === input) return item;
    }
    return null;
  }

  async function findEvent(eventId, calendarId) {
    const resolved = resolveCalendar(calendarId);
    if (resolved.error) return resolved;
    const { calendar } = resolved;
    const rangeStart = cal.dtz.jsDateToDateTime(new Date(0), cal.dtz.defaultTimezone);
    const rangeEnd = cal.dtz.jsDateToDateTime(new Date(2100, 0, 1), cal.dtz.defaultTimezone);
    const items = await getCalendarItems(calendar, rangeStart, rangeEnd);
    const item = resolveEventId(eventId, items);
    if (!item) {
      return { error: `Event not found: ${eventId}` };
    }
    return { item, calendar };
  }

  async function createEvent(args) {
    const { title, startDate, endDate, location, description, calendarId, allDay, recurrence } = args;
    mcpDebug("createEvent", { title, startDate, endDate, calendarId, allDay });
    if (!calendarId) {
      return { error: "calendarId is required. Use listCalendars to find available calendar IDs." };
    }
    if (!cal || !CalEvent) {
      return { error: "Calendar module not available" };
    }
    try {
      const startJs = parseDate(startDate);
      if (isNaN(startJs.getTime())) {
        return { error: `Invalid startDate: ${startDate}` };
      }

      let endJs = endDate ? parseDate(endDate) : null;
      if (endDate && (!endJs || isNaN(endJs.getTime()))) {
        return { error: `Invalid endDate: ${endDate}` };
      }

      if (endJs) {
        if (allDay) {
          const startDay = new Date(startJs.getFullYear(), startJs.getMonth(), startJs.getDate());
          const endDay = new Date(endJs.getFullYear(), endJs.getMonth(), endJs.getDate());
          if (endDay.getTime() < startDay.getTime()) {
            return { error: "endDate must not be before startDate" };
          }
        } else if (endJs.getTime() <= startJs.getTime()) {
          return { error: "endDate must be after startDate" };
        }
      }

      const event = new CalEvent();
      event.title = title;

      if (allDay) {
        const startDt = cal.createDateTime();
        startDt.resetTo(startJs.getFullYear(), startJs.getMonth(), startJs.getDate(), 0, 0, 0, cal.dtz.floating);
        startDt.isDate = true;
        event.startDate = startDt;

        const endDt = cal.createDateTime();
        if (endJs) {
          const bumpedEnd = new Date(endJs.getFullYear(), endJs.getMonth(), endJs.getDate());
          bumpedEnd.setDate(bumpedEnd.getDate() + 1);
          endDt.resetTo(
            bumpedEnd.getFullYear(),
            bumpedEnd.getMonth(),
            bumpedEnd.getDate(),
            0, 0, 0,
            cal.dtz.floating
          );
          endDt.isDate = true;
        } else {
          const defaultEnd = new Date(startJs.getTime());
          defaultEnd.setDate(defaultEnd.getDate() + 1);
          endDt.resetTo(
            defaultEnd.getFullYear(),
            defaultEnd.getMonth(),
            defaultEnd.getDate(),
            0, 0, 0,
            cal.dtz.floating
          );
          endDt.isDate = true;
        }
        event.endDate = endDt;
      } else {
        event.startDate = cal.dtz.jsDateToDateTime(startJs, cal.dtz.defaultTimezone);
        if (endJs) {
          event.endDate = cal.dtz.jsDateToDateTime(endJs, cal.dtz.defaultTimezone);
        } else {
          const defaultEnd = new Date(startJs.getTime() + 3600000);
          event.endDate = cal.dtz.jsDateToDateTime(defaultEnd, cal.dtz.defaultTimezone);
        }
      }

      if (location) event.setProperty("LOCATION", location);
      if (description) event.setProperty("DESCRIPTION", description);

      if (recurrence) {
        try {
          const { CalRecurrenceInfo } = ChromeUtils.importESModule("resource:///modules/CalRecurrenceInfo.sys.mjs");
          const { CalRecurrenceRule } = ChromeUtils.importESModule("resource:///modules/CalRecurrenceRule.sys.mjs");
          const recInfo = new CalRecurrenceInfo(event);
          const rule = new CalRecurrenceRule();
          const icalString = recurrence.startsWith("RRULE:") ? recurrence : `RRULE:${recurrence}`;
          rule.icalString = icalString;
          recInfo.appendRecurrenceItem(rule);
          event.recurrenceInfo = recInfo;
        } catch (e) {
          return { error: `Invalid recurrence rule: ${e.message || e}` };
        }
      }

      const resolved = findWritableCalendar(calendarId);
      if (resolved.error) return resolved;
      const targetCalendar = resolved.calendar;

      event.calendar = targetCalendar;
      await targetCalendar.addItem(event);
      return { message: `Requested creation of event "${title}" on calendar "${calendarPath(targetCalendar)}"`, calendar: calendarPath(targetCalendar) };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  async function listEvents(args) {
    const { calendarId, startDate, endDate, maxResults } = args;
    if (!cal) {
      return { error: "Calendar not available" };
    }
    try {
      const calendars = cal.manager.getCalendars();
      let targets = calendars;
      if (calendarId) {
        const resolved = resolveCalendar(calendarId);
        if (resolved.error) return resolved;
        targets = [resolved.calendar];
      }

      const startJs = startDate ? parseDate(startDate) : new Date();
      if (isNaN(startJs.getTime())) {
        return { error: `Invalid startDate: ${startDate}` };
      }
      const endJs = endDate ? parseDate(endDate) : new Date(Date.now() + 7 * 86400000);
      if (isNaN(endJs.getTime())) {
        return { error: `Invalid endDate: ${endDate}` };
      }

      const rangeStart = cal.dtz.jsDateToDateTime(startJs, cal.dtz.defaultTimezone);
      const rangeEnd = cal.dtz.jsDateToDateTime(endJs, cal.dtz.defaultTimezone);
      const startMs = startJs.getTime();
      const endMs = endJs.getTime();
      const limit = Math.min(maxResults || 100, 500);

      function formatItem(item, calendar, seriesParent) {
        const start = formatCalDateTime(item.startDate);
        let end = formatCalDateTime(item.endDate);
        const isAllDay = item.startDate ? item.startDate.isDate : false;
        if (isAllDay && item.endDate) {
          const d = new Date(item.endDate.year, item.endDate.month, item.endDate.day);
          d.setDate(d.getDate() - 1);
          const pad = (n) => String(n).padStart(2, "0");
          end = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00`;
        }
        const result = {
          id: shortId(item.id),
          calendar: calendarPath(calendar),
          title: item.title || "",
          startDate: start,
          endDate: end,
          location: item.getProperty("LOCATION") || "",
          description: item.getProperty("DESCRIPTION") || "",
          allDay: isAllDay,
        };
        const parent = seriesParent || (item.parentItem && item.parentItem !== item ? item.parentItem : null);
        const recSource = item.recurrenceInfo || (parent ? parent.recurrenceInfo : null);
        if (recSource) {
          try {
            const rules = [];
            for (let i = 0; i < recSource.countRecurrenceItems(); i++) {
              const rItem = recSource.getRecurrenceItemAt(i);
              if (rItem.icalString) {
                rules.push(rItem.icalString.replace(/^RRULE:/, "").trim());
              }
            }
            if (rules.length > 0) result.recurrence = rules.join(";");
          } catch {}
          if (parent && parent.startDate) {
            result.seriesStartDate = formatCalDateTime(parent.startDate);
          }
        }
        return result;
      }

      const results = [];
      for (const calendar of targets) {
        const items = await getCalendarItems(calendar, null, null);
        for (const item of items) {
          if (item.recurrenceInfo) {
            try {
              const occurrences = item.getOccurrencesBetween(rangeStart, rangeEnd);
              for (const occ of occurrences) {
                results.push(formatItem(occ, calendar, item));
                if (results.length >= limit) break;
              }
            } catch (e) { mcpWarn("recurring event expansion", e);
              results.push(formatItem(item, calendar));
            }
          } else {
            if (item.startDate) {
              const itemMs = item.startDate.nativeTime / 1000;
              if (itemMs < startMs || itemMs >= endMs) continue;
            }
            results.push(formatItem(item, calendar));
          }
          if (results.length >= limit) break;
        }
        if (results.length >= limit) break;
      }

      results.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
      return results;
    } catch (e) {
      return { error: e.toString() };
    }
  }

  async function updateEvent(args) {
    const { eventId, calendarId, title, startDate, endDate, location, description, recurrence } = args;
    mcpDebug("updateEvent", { eventId, calendarId, title });
    if (!cal) {
      return { error: "Calendar not available" };
    }
    try {
      if (typeof eventId !== "string" || !eventId) {
        return { error: "eventId must be a non-empty string" };
      }
      if (typeof calendarId !== "string" || !calendarId) {
        return { error: "calendarId must be a non-empty string" };
      }

      const found = await findEvent(eventId, calendarId);
      if (found.error) return found;
      const { item: oldItem, calendar } = found;

      if (calendar.readOnly) {
        return { error: `Calendar is read-only: ${calendarPath(calendar)}` };
      }
      if (!oldItem) {
        return { error: `Event not found: ${eventId}` };
      }

      const newItem = oldItem.clone();
      const changes = [];

      if (title !== undefined) {
        newItem.title = title;
        changes.push("title");
      }

      if (startDate !== undefined) {
        const js = parseDate(startDate);
        if (isNaN(js.getTime())) {
          return { error: `Invalid startDate: ${startDate}` };
        }
        if (newItem.startDate && newItem.startDate.isDate) {
          const dt = cal.createDateTime();
          dt.resetTo(js.getFullYear(), js.getMonth(), js.getDate(), 0, 0, 0, cal.dtz.floating);
          dt.isDate = true;
          newItem.startDate = dt;
        } else {
          newItem.startDate = cal.dtz.jsDateToDateTime(js, cal.dtz.defaultTimezone);
        }
        changes.push("startDate");
      }

      if (endDate !== undefined) {
        const js = parseDate(endDate);
        if (isNaN(js.getTime())) {
          return { error: `Invalid endDate: ${endDate}` };
        }
        if (newItem.endDate && newItem.endDate.isDate) {
          const bumped = new Date(js.getFullYear(), js.getMonth(), js.getDate());
          bumped.setDate(bumped.getDate() + 1);
          const dt = cal.createDateTime();
          dt.resetTo(bumped.getFullYear(), bumped.getMonth(), bumped.getDate(), 0, 0, 0, cal.dtz.floating);
          dt.isDate = true;
          newItem.endDate = dt;
        } else {
          newItem.endDate = cal.dtz.jsDateToDateTime(js, cal.dtz.defaultTimezone);
        }
        changes.push("endDate");
      }

      if (location !== undefined) {
        newItem.setProperty("LOCATION", location);
        changes.push("location");
      }

      if (description !== undefined) {
        newItem.setProperty("DESCRIPTION", description);
        changes.push("description");
      }

      if (recurrence !== undefined) {
        try {
          if (recurrence === null || recurrence === "") {
            newItem.recurrenceInfo = null;
          } else {
            const { CalRecurrenceInfo } = ChromeUtils.importESModule("resource:///modules/CalRecurrenceInfo.sys.mjs");
            const { CalRecurrenceRule } = ChromeUtils.importESModule("resource:///modules/CalRecurrenceRule.sys.mjs");
            const recInfo = new CalRecurrenceInfo(newItem);
            const rule = new CalRecurrenceRule();
            const icalString = recurrence.startsWith("RRULE:") ? recurrence : `RRULE:${recurrence}`;
            rule.icalString = icalString;
            recInfo.appendRecurrenceItem(rule);
            newItem.recurrenceInfo = recInfo;
          }
          changes.push("recurrence");
        } catch (e) {
          return { error: `Invalid recurrence rule: ${e.message || e}` };
        }
      }

      if (changes.length === 0) {
        return { error: "No changes specified" };
      }

      await calendar.modifyItem(newItem, oldItem);
      return { message: `Requested update of event`, updated: changes, calendar: calendarPath(calendar) };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  async function deleteEvent(args) {
    const { eventId, calendarId } = args;
    mcpDebug("deleteEvent", { eventId, calendarId });
    if (!cal) {
      return { error: "Calendar not available" };
    }
    try {
      if (typeof eventId !== "string" || !eventId) {
        return { error: "eventId must be a non-empty string" };
      }
      if (typeof calendarId !== "string" || !calendarId) {
        return { error: "calendarId must be a non-empty string" };
      }

      const found = await findEvent(eventId, calendarId);
      if (found.error) return found;
      const { item, calendar } = found;

      if (calendar.readOnly) {
        return { error: `Calendar is read-only: ${calendarPath(calendar)}` };
      }

      await calendar.deleteItem(item);
      return { message: `Requested deletion of event`, deleted: eventId, calendar: calendarPath(calendar) };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  async function moveEvent(args) {
    const { eventId, calendarId, destinationCalendarId } = args;
    mcpDebug("moveEvent", { eventId, calendarId, destinationCalendarId });
    if (!cal) {
      return { error: "Calendar not available" };
    }
    try {
      if (!eventId || !calendarId || !destinationCalendarId) {
        return { error: "eventId, calendarId, and destinationCalendarId are all required" };
      }
      const found = await findEvent(eventId, calendarId);
      if (found.error) return found;
      const { item, calendar: srcCalendar } = found;

      if (srcCalendar.readOnly) {
        return { error: `Source calendar is read-only: ${calendarPath(srcCalendar)}` };
      }

      const destResolved = resolveCalendar(destinationCalendarId);
      if (destResolved.error) return { error: `Destination calendar: ${destResolved.error}` };
      const destCalendar = destResolved.calendar;

      if (srcCalendar.id === destCalendar.id) {
        return { error: "Source and destination calendars are the same" };
      }
      if (destCalendar.readOnly) {
        return { error: `Destination calendar is read-only: ${calendarPath(destCalendar)}` };
      }

      const newItem = item.clone();
      newItem.calendar = destCalendar;
      await destCalendar.addItem(newItem);
      await srcCalendar.deleteItem(item);

      return {
        message: `Moved event "${item.title}" from "${calendarPath(srcCalendar)}" to "${calendarPath(destCalendar)}"`,
        eventId,
        from: calendarPath(srcCalendar),
        to: calendarPath(destCalendar),
      };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  return {
    listCalendars: () => listCalendars(),
    listEvents,
    createEvent,
    updateEvent,
    deleteEvent,
    moveEvent,
  };
}
