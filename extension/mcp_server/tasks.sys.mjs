// tasks.sys.mjs — Task (todo) tools: list, create, update, delete

export function createTaskHandlers({ cal, CalTodo, utils }) {
  const { mcpWarn, mcpDebug, parseDate, formatCalDateTime, findWritableCalendar } = utils;

  async function getCalendarTodos(calendar, rangeStart, rangeEnd) {
    const FILTER_ALL = 0xFFFF;
    let allItems;
    if (typeof calendar.getItemsAsArray === "function") {
      allItems = await calendar.getItemsAsArray(FILTER_ALL, 0, rangeStart, rangeEnd);
    } else {
      allItems = [];
      const stream = cal.iterate.streamValues(calendar.getItems(FILTER_ALL, 0, rangeStart, rangeEnd));
      for await (const chunk of stream) {
        for (const i of chunk) allItems.push(i);
      }
    }
    return allItems.filter(i =>
      (typeof i.isTodo === "function" && i.isTodo()) ||
      (i.icalString && i.icalString.includes("VTODO"))
    );
  }

  async function findTodo(taskId, calendarId) {
    const calendar = cal.manager.getCalendars().find(c => c.id === calendarId);
    if (!calendar) {
      return { error: `Calendar not found: ${calendarId}` };
    }
    const items = await getCalendarTodos(calendar, null, null);
    const item = items.find(i => i.id === taskId);
    if (!item) {
      return { error: `Task not found: ${taskId}` };
    }
    return { item, calendar };
  }

  function formatTodo(item, calendar) {
    const entryDate = formatCalDateTime(item.entryDate);
    const dueDate = formatCalDateTime(item.dueDate);
    const completedDate = formatCalDateTime(item.completedDate);
    return {
      id: item.id,
      calendarId: calendar.id,
      calendarName: calendar.name,
      title: item.title || "",
      entryDate,
      dueDate,
      completedDate,
      percentComplete: item.percentComplete || 0,
      status: item.status || "NONE",
      priority: item.priority || 0,
      description: item.getProperty("DESCRIPTION") || "",
      location: item.getProperty("LOCATION") || "",
    };
  }

  async function listTasks(args) {
    const { calendarId, startDate, endDate, maxResults, includeCompleted } = args;
    if (!cal) {
      return { error: "Calendar not available" };
    }
    try {
      const calendars = cal.manager.getCalendars();
      let targets = calendars;
      if (calendarId) {
        const found = calendars.find(c => c.id === calendarId);
        if (!found) {
          return { error: `Calendar not found: ${calendarId}` };
        }
        targets = [found];
      }

      const limit = Math.min(maxResults || 100, 500);
      const results = [];

      for (const calendar of targets) {
        const items = await getCalendarTodos(calendar, null, null);
        for (const item of items) {
          if (!includeCompleted && item.percentComplete === 100) continue;

          if (startDate || endDate) {
            const dueMs = item.dueDate ? item.dueDate.nativeTime / 1000 : null;
            if (startDate && dueMs) {
              const startMs = parseDate(startDate).getTime();
              if (!isNaN(startMs) && dueMs < startMs) continue;
            }
            if (endDate && dueMs) {
              const endMs = parseDate(endDate).getTime();
              if (!isNaN(endMs) && dueMs > endMs) continue;
            }
          }

          results.push(formatTodo(item, calendar));
          if (results.length >= limit) break;
        }
        if (results.length >= limit) break;
      }

      results.sort((a, b) => {
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return new Date(a.dueDate) - new Date(b.dueDate);
      });
      return results;
    } catch (e) {
      return { error: e.toString() };
    }
  }

  async function createTask(args) {
    const { title, dueDate, description, calendarId, priority } = args;
    mcpDebug("createTask", { title, calendarId, dueDate });
    if (!cal || !CalTodo) {
      return { error: "Calendar module not available" };
    }
    try {
      const todo = new CalTodo();
      todo.title = title;

      if (dueDate) {
        const js = parseDate(dueDate);
        if (isNaN(js.getTime())) {
          return { error: `Invalid dueDate: ${dueDate}` };
        }
        todo.dueDate = cal.dtz.jsDateToDateTime(js, cal.dtz.defaultTimezone);
      }

      const entryJs = new Date();
      todo.entryDate = cal.dtz.jsDateToDateTime(entryJs, cal.dtz.defaultTimezone);

      if (description) todo.setProperty("DESCRIPTION", description);
      if (priority !== undefined) {
        const p = Number(priority);
        if (p >= 0 && p <= 9) todo.priority = p;
      }

      const resolved = findWritableCalendar(calendarId);
      if (resolved.error) return resolved;
      const targetCalendar = resolved.calendar;

      todo.calendar = targetCalendar;
      await targetCalendar.addItem(todo);
      return { message: `Requested creation of task "${title}" on calendar "${targetCalendar.name}"`, calendarId: targetCalendar.id, calendarName: targetCalendar.name };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  async function updateTask(args) {
    const { taskId, calendarId, title, dueDate, description, priority, percentComplete, status } = args;
    mcpDebug("updateTask", { taskId, calendarId, title, status });
    if (!cal) {
      return { error: "Calendar not available" };
    }
    try {
      const found = await findTodo(taskId, calendarId);
      if (found.error) return found;
      const { item: oldItem, calendar } = found;

      if (calendar.readOnly) {
        return { error: `Calendar is read-only: ${calendar.name}` };
      }

      const newItem = oldItem.clone();
      const changes = [];

      if (title !== undefined) {
        newItem.title = title;
        changes.push("title");
      }
      if (dueDate !== undefined) {
        if (dueDate === null || dueDate === "") {
          newItem.dueDate = null;
        } else {
          const js = parseDate(dueDate);
          if (isNaN(js.getTime())) {
            return { error: `Invalid dueDate: ${dueDate}` };
          }
          newItem.dueDate = cal.dtz.jsDateToDateTime(js, cal.dtz.defaultTimezone);
        }
        changes.push("dueDate");
      }
      if (description !== undefined) {
        newItem.setProperty("DESCRIPTION", description);
        changes.push("description");
      }
      if (priority !== undefined) {
        const p = Number(priority);
        if (p >= 0 && p <= 9) {
          newItem.priority = p;
          changes.push("priority");
        }
      }
      if (status !== undefined) {
        const validStatuses = ["NONE", "IN-PROCESS", "COMPLETED", "NEEDS-ACTION", "CANCELLED"];
        if (validStatuses.includes(status)) {
          newItem.status = status;
          if (status === "COMPLETED") {
            newItem.percentComplete = 100;
            newItem.completedDate = cal.dtz.jsDateToDateTime(new Date(), cal.dtz.defaultTimezone);
          }
          changes.push("status");
        }
      }
      if (percentComplete !== undefined) {
        const pct = Number(percentComplete);
        if (pct >= 0 && pct <= 100) {
          newItem.percentComplete = pct;
          if (pct === 100) {
            newItem.completedDate = cal.dtz.jsDateToDateTime(new Date(), cal.dtz.defaultTimezone);
          }
          changes.push("percentComplete");
        }
      }

      if (changes.length === 0) {
        return { error: "No changes specified" };
      }

      await calendar.modifyItem(newItem, oldItem);
      return { message: `Requested update of task`, updated: changes, calendarId: calendar.id, calendarName: calendar.name };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  async function deleteTask(args) {
    const { taskId, calendarId } = args;
    mcpDebug("deleteTask", { taskId, calendarId });
    if (!cal) {
      return { error: "Calendar not available" };
    }
    try {
      const found = await findTodo(taskId, calendarId);
      if (found.error) return found;
      const { item, calendar } = found;

      if (calendar.readOnly) {
        return { error: `Calendar is read-only: ${calendar.name}` };
      }

      await calendar.deleteItem(item);
      return { message: `Requested deletion of task`, deleted: taskId, calendarId: calendar.id, calendarName: calendar.name };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  async function moveTask(args) {
    const { taskId, calendarId, destinationCalendarId } = args;
    mcpDebug("moveTask", { taskId, calendarId, destinationCalendarId });
    if (!cal) {
      return { error: "Calendar not available" };
    }
    try {
      if (!taskId || !calendarId || !destinationCalendarId) {
        return { error: "taskId, calendarId, and destinationCalendarId are all required" };
      }
      if (calendarId === destinationCalendarId) {
        return { error: "Source and destination calendars are the same" };
      }

      const found = await findTodo(taskId, calendarId);
      if (found.error) return found;
      const { item, calendar: srcCalendar } = found;

      if (srcCalendar.readOnly) {
        return { error: `Source calendar is read-only: ${srcCalendar.name}` };
      }

      const destCalendar = cal.manager.getCalendars().find(c => c.id === destinationCalendarId);
      if (!destCalendar) {
        return { error: `Destination calendar not found: ${destinationCalendarId}` };
      }
      if (destCalendar.readOnly) {
        return { error: `Destination calendar is read-only: ${destCalendar.name}` };
      }

      const newItem = item.clone();
      newItem.calendar = destCalendar;
      await destCalendar.addItem(newItem);
      await srcCalendar.deleteItem(item);

      return {
        message: `Moved task "${item.title}" from "${srcCalendar.name}" to "${destCalendar.name}"`,
        taskId,
        fromCalendarId: srcCalendar.id,
        fromCalendarName: srcCalendar.name,
        toCalendarId: destCalendar.id,
        toCalendarName: destCalendar.name,
      };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  return {
    listTasks,
    createTask,
    updateTask,
    deleteTask,
    moveTask,
  };
}
