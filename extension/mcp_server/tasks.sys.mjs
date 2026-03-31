// tasks.sys.mjs — Task (todo) tools: list, create, update, delete

export function createTaskHandlers({ cal, CalTodo, utils }) {
  const { mcpWarn, mcpDebug, parseDate, formatCalDateTime, findWritableCalendar, resolveCalendar, calendarPath, shortId } = utils;

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

  function resolveTaskId(input, items) {
    if (!input || typeof input !== "string") return null;
    const direct = items.find(i => i.id === input);
    if (direct) return direct;
    for (const item of items) {
      if (shortId(item.id) === input) return item;
    }
    return null;
  }

  async function findTodo(taskId, calendarId) {
    const resolved = resolveCalendar(calendarId);
    if (resolved.error) return resolved;
    const { calendar } = resolved;
    const items = await getCalendarTodos(calendar, null, null);
    const item = resolveTaskId(taskId, items);
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
      id: shortId(item.id),
      calendar: calendarPath(calendar),
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
        const resolved = resolveCalendar(calendarId);
        if (resolved.error) return resolved;
        targets = [resolved.calendar];
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
    if (!calendarId) {
      return { error: "calendarId is required. Use listCalendars to find available calendar IDs." };
    }
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
      return { message: `Requested creation of task "${title}" on calendar "${calendarPath(targetCalendar)}"`, calendar: calendarPath(targetCalendar) };
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
        return { error: `Calendar is read-only: ${calendarPath(calendar)}` };
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
      return { message: `Requested update of task`, updated: changes, calendar: calendarPath(calendar) };
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
        return { error: `Calendar is read-only: ${calendarPath(calendar)}` };
      }

      await calendar.deleteItem(item);
      return { message: `Requested deletion of task`, deleted: taskId, calendar: calendarPath(calendar) };
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
      const found = await findTodo(taskId, calendarId);
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
        message: `Moved task "${item.title}" from "${calendarPath(srcCalendar)}" to "${calendarPath(destCalendar)}"`,
        taskId,
        from: calendarPath(srcCalendar),
        to: calendarPath(destCalendar),
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
