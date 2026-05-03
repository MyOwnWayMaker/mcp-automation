import { mapsClassifyQuadrant } from "../dist/tools/maps.js";

const cases = [
  // Central
  ["4470 Ventura Canyon Ave, Sherman Oaks, CA", "Central"],
  ["Studio City, CA", "Central"],
  ["Encino, CA", "Central"],
  // N
  ["Granada Hills, CA", "N"],
  ["Sylmar, CA", "N"],
  ["Santa Clarita, CA", "N"],
  ["Northridge, CA", "N"],
  // W
  ["Calabasas, CA", "W"],
  ["Topanga, CA", "W"],
  ["Malibu Pier, Malibu, CA", "W"],
  ["Thousand Oaks, CA", "W"],
  // E
  ["Burbank, CA", "E"],
  ["Glendale, CA", "E"],
  ["Pasadena City Hall, Pasadena, CA", "E"],
  ["Hollywood, Los Angeles, CA", "E"],
  ["Downtown Los Angeles, CA", "E"],
  ["San Bernardino, CA", "E"],
  ["Riverside, CA", "E"],
  ["Pomona, CA", "E"],
  // S
  ["Beverly Hills, CA", "S"],
  ["Westwood, Los Angeles, CA", "S"],
  ["Santa Monica, CA", "S"],
  ["Culver City, CA", "S"],
  ["LAX Airport, Los Angeles, CA", "S"],
  ["Inglewood, CA", "S"],
  ["Anaheim, CA", "S"],
  ["Irvine, CA", "S"],
  ["San Diego, CA", "S"],
];

let pass = 0, fail = 0;
for (const [addr, expected] of cases) {
  const r = await mapsClassifyQuadrant({ address: addr });
  const data = JSON.parse(r.content[0].text);
  const got = data.ok ? data.quadrant : `ERROR(${data.error})`;
  const status = got === expected ? "✓" : "✗";
  if (got === expected) pass++; else fail++;
  console.log(`${status} ${addr.padEnd(45)} -> ${got.padEnd(8)} expected ${expected}  (${data.distance_miles ?? "?"} mi, bearing ${data.bearing_degrees ?? "?"}°)`);
}
console.log(`\n${pass} passed, ${fail} failed of ${cases.length}`);
