import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function getHeaders() {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN environment variable not set.");
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

const BASE = "https://api.hubapi.com";

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

async function hsGet(path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: getHeaders() });
  if (!res.ok) throw new Error(`HubSpot API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<any>;
}

async function hsPost(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HubSpot API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<any>;
}

async function hsPatch(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HubSpot API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<any>;
}

function formatContact(c: any) {
  const p = c.properties ?? {};
  return `ID: ${c.id}\nName: ${p.firstname ?? ""} ${p.lastname ?? ""}\nEmail: ${p.email ?? ""}\nPhone: ${p.phone ?? ""}\nCompany: ${p.company ?? ""}`.trim();
}

function formatDeal(d: any) {
  const p = d.properties ?? {};
  return `ID: ${d.id}\nName: ${p.dealname ?? ""}\nStage: ${p.dealstage ?? ""}\nAmount: ${p.amount ?? ""}\nClose Date: ${p.closedate ?? ""}`;
}

function formatCompany(c: any) {
  const p = c.properties ?? {};
  return `ID: ${c.id}\nName: ${p.name ?? ""}\nDomain: ${p.domain ?? ""}\nIndustry: ${p.industry ?? ""}`;
}

// Contacts
export async function hubspotFindContact(args: { email: string }): Promise<CallToolResult> {
  const res = await hsPost("/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: args.email }] }],
    properties: ["firstname", "lastname", "email", "phone", "company"],
  });
  if (!res.results?.length) return ok(`No contact found with email: ${args.email}`);
  return ok(res.results.map(formatContact).join("\n\n---\n\n"));
}

export async function hubspotCreateContact(args: {
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  company?: string;
}): Promise<CallToolResult> {
  const res = await hsPost("/crm/v3/objects/contacts", {
    properties: {
      email: args.email,
      firstname: args.first_name,
      lastname: args.last_name,
      phone: args.phone,
      company: args.company,
    },
  });
  return ok(`Contact created:\n${formatContact(res)}`);
}

export async function hubspotUpdateContact(args: {
  contact_id: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  company?: string;
  email?: string;
}): Promise<CallToolResult> {
  const { contact_id, ...fields } = args;
  const properties: any = {};
  if (fields.first_name) properties.firstname = fields.first_name;
  if (fields.last_name) properties.lastname = fields.last_name;
  if (fields.phone) properties.phone = fields.phone;
  if (fields.company) properties.company = fields.company;
  if (fields.email) properties.email = fields.email;
  const res = await hsPatch(`/crm/v3/objects/contacts/${contact_id}`, { properties });
  return ok(`Contact updated:\n${formatContact(res)}`);
}

// Deals
export async function hubspotCreateDeal(args: {
  name: string;
  stage: string;
  amount?: string;
  close_date?: string;
}): Promise<CallToolResult> {
  const res = await hsPost("/crm/v3/objects/deals", {
    properties: {
      dealname: args.name,
      dealstage: args.stage,
      amount: args.amount,
      closedate: args.close_date,
    },
  });
  return ok(`Deal created:\n${formatDeal(res)}`);
}

export async function hubspotFindDeal(args: { name: string }): Promise<CallToolResult> {
  const res = await hsPost("/crm/v3/objects/deals/search", {
    filterGroups: [{ filters: [{ propertyName: "dealname", operator: "CONTAINS_TOKEN", value: args.name }] }],
    properties: ["dealname", "dealstage", "amount", "closedate"],
  });
  if (!res.results?.length) return ok(`No deal found matching: ${args.name}`);
  return ok(res.results.map(formatDeal).join("\n\n---\n\n"));
}

export async function hubspotUpdateDeal(args: {
  deal_id: string;
  name?: string;
  stage?: string;
  amount?: string;
  close_date?: string;
}): Promise<CallToolResult> {
  const properties: any = {};
  if (args.name) properties.dealname = args.name;
  if (args.stage) properties.dealstage = args.stage;
  if (args.amount) properties.amount = args.amount;
  if (args.close_date) properties.closedate = args.close_date;
  const res = await hsPatch(`/crm/v3/objects/deals/${args.deal_id}`, { properties });
  return ok(`Deal updated:\n${formatDeal(res)}`);
}

// Companies
export async function hubspotCreateCompany(args: {
  name: string;
  domain?: string;
  industry?: string;
}): Promise<CallToolResult> {
  const res = await hsPost("/crm/v3/objects/companies", {
    properties: { name: args.name, domain: args.domain, industry: args.industry },
  });
  return ok(`Company created:\n${formatCompany(res)}`);
}

export async function hubspotFindCompany(args: { name: string }): Promise<CallToolResult> {
  const res = await hsPost("/crm/v3/objects/companies/search", {
    filterGroups: [{ filters: [{ propertyName: "name", operator: "CONTAINS_TOKEN", value: args.name }] }],
    properties: ["name", "domain", "industry"],
  });
  if (!res.results?.length) return ok(`No company found matching: ${args.name}`);
  return ok(res.results.map(formatCompany).join("\n\n---\n\n"));
}

// Notes / Engagements
export async function hubspotCreateNote(args: {
  body: string;
  contact_id?: string;
  deal_id?: string;
}): Promise<CallToolResult> {
  const note = await hsPost("/crm/v3/objects/notes", {
    properties: { hs_note_body: args.body, hs_timestamp: Date.now().toString() },
  });

  if (args.contact_id) {
    await hsPost(`/crm/v3/objects/notes/${note.id}/associations/contacts/${args.contact_id}/note_to_contact`, {});
  }
  if (args.deal_id) {
    await hsPost(`/crm/v3/objects/notes/${note.id}/associations/deals/${args.deal_id}/note_to_deal`, {});
  }

  return ok(`Note created. ID: ${note.id}`);
}
