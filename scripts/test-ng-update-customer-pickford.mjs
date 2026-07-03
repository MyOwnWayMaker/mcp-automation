// Direct test runner for the new notarygadget_update_customer tool against the LIVE site.
// Compiles + imports the built JS so it's an honest end-to-end run.
import dotenv from "dotenv";
dotenv.config({ path: "/Users/dino/mcp-automation/.env" });

const mod = await import("/Users/dino/mcp-automation/dist/tools/notarygadget.js");
const { notarygadgetUpdateCustomer } = mod;

console.log("=== Updating Pickford Escrow (ID 244654) to 12100 Wilshire Blvd Ste 1040, LA 90025 ===\n");

const result = await notarygadgetUpdateCustomer({
  customer_id: "244654",
  address1: "12100 Wilshire Blvd",
  address2: "Suite 1040",
  city: "Los Angeles",
  state: "CA",
  zip: "90025",
});

for (const c of result.content) {
  console.log(c.text);
}
