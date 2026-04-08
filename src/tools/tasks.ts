import { google } from "googleapis";
import { getGoogleAuthClient } from "../auth/google.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

async function getTasks() {
  const auth = await getGoogleAuthClient();
  return google.tasks({ version: "v1", auth });
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export async function tasksListTasklists(): Promise<CallToolResult> {
  const tasks = await getTasks();
  const res = await tasks.tasklists.list();
  const lists = res.data.items ?? [];
  if (lists.length === 0) return ok("No task lists found.");
  const lines = lists.map((l) => `ID: ${l.id}\nName: ${l.title}`);
  return ok(lines.join("\n\n---\n\n"));
}

export async function tasksListTasks(args: {
  tasklist_id?: string;
  show_completed?: boolean;
}): Promise<CallToolResult> {
  const tasks = await getTasks();
  const res = await tasks.tasks.list({
    tasklist: args.tasklist_id ?? "@default",
    showCompleted: args.show_completed ?? false,
    showHidden: false,
  });

  const items = res.data.items ?? [];
  if (items.length === 0) return ok("No tasks found.");

  const lines = items.map((t) =>
    `ID: ${t.id}\nTitle: ${t.title}\nStatus: ${t.status}${t.due ? `\nDue: ${t.due}` : ""}${t.notes ? `\nNotes: ${t.notes}` : ""}`
  );
  return ok(lines.join("\n\n---\n\n"));
}

export async function tasksCreateTask(args: {
  title: string;
  notes?: string;
  due?: string;
  tasklist_id?: string;
}): Promise<CallToolResult> {
  const tasks = await getTasks();
  const res = await tasks.tasks.insert({
    tasklist: args.tasklist_id ?? "@default",
    requestBody: {
      title: args.title,
      notes: args.notes,
      due: args.due,
    },
  });
  return ok(`Task created: ${res.data.title}\nID: ${res.data.id}`);
}

export async function tasksUpdateTask(args: {
  task_id: string;
  title?: string;
  notes?: string;
  due?: string;
  status?: "needsAction" | "completed";
  tasklist_id?: string;
}): Promise<CallToolResult> {
  const tasks = await getTasks();
  const tasklistId = args.tasklist_id ?? "@default";

  const existing = await tasks.tasks.get({ tasklist: tasklistId, task: args.task_id });

  const res = await tasks.tasks.update({
    tasklist: tasklistId,
    task: args.task_id,
    requestBody: {
      ...existing.data,
      ...(args.title && { title: args.title }),
      ...(args.notes !== undefined && { notes: args.notes }),
      ...(args.due !== undefined && { due: args.due }),
      ...(args.status && { status: args.status }),
    },
  });
  return ok(`Task updated: ${res.data.title}\nStatus: ${res.data.status}`);
}

export async function tasksCompleteTask(args: {
  task_id: string;
  tasklist_id?: string;
}): Promise<CallToolResult> {
  return tasksUpdateTask({ ...args, status: "completed" });
}

export async function tasksDeleteTask(args: {
  task_id: string;
  tasklist_id?: string;
}): Promise<CallToolResult> {
  const tasks = await getTasks();
  await tasks.tasks.delete({
    tasklist: args.tasklist_id ?? "@default",
    task: args.task_id,
  });
  return ok(`Task ${args.task_id} deleted.`);
}
