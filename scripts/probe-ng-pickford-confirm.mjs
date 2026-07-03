// Confirm IDs for Pickford Escrow — open EditContact for 244654 and 313375 and print their company name + address.
import { chromium } from "playwright";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/dino/mcp-automation/.env" });

const NG_URL = "https://www.notarygadget.com";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();

await page.goto(`${NG_URL}/UserLogin`);
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector("#txtUsername", { timeout: 20000 });
await page.fill("#txtUsername", process.env.NOTARYGADGET_EMAIL);
await page.fill("#txtPassword", process.env.NOTARYGADGET_PASSWORD);
await page.evaluate(() => window.Login());
await page.waitForTimeout(8000);

await page.evaluate(() => window.SelectPage("Contacts"));
await page.waitForTimeout(4000);

for (const id of ["244654", "313375"]) {
  console.log(`\n=== EditContact('${id}') ===`);
  await page.evaluate((cid) => window.EditContact(cid), id);
  await page.waitForTimeout(2500);

  const fields = await page.evaluate(() => ({
    company: document.getElementById("txtCompany")?.value || "",
    addr1: document.getElementById("txtAddress1")?.value || "",
    addr2: document.getElementById("txtAddress2")?.value || "",
    city: document.getElementById("txtCity")?.value || "",
    state: document.getElementById("txtState")?.value || "",
    zip: document.getElementById("txtZip")?.value || "",
    first: document.getElementById("txtFirst")?.value || "",
    last: document.getElementById("txtLast")?.value || "",
    email: document.getElementById("txtEmail")?.value || "",
    office: document.getElementById("txtOffice")?.value || "",
    cell: document.getElementById("txtCell")?.value || "",
    invEmail: document.getElementById("txtInvEmail")?.value || "",
  }));
  console.log("Company:", fields.company);
  console.log("Address1:", fields.addr1);
  console.log("Address2:", fields.addr2);
  console.log("City:", fields.city);
  console.log("State:", fields.state);
  console.log("ZIP:", fields.zip);
  console.log("Contact:", fields.first, fields.last);
  console.log("Email:", fields.email);
  console.log("Office:", fields.office);
  console.log("Cell:", fields.cell);
  console.log("Invoice Email:", fields.invEmail);

  // Close modal
  await page.evaluate(() => window.CloseOperationWindow && window.CloseOperationWindow()).catch(() => {});
  await page.waitForTimeout(1000);
}

await browser.close();
console.log("\n=== DONE ===");
