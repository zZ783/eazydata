import fs from "node:fs";

const png = fs.readFileSync("assets/icon.png").toString("base64");
// A 256x256 SVG embedding the exact PNG, served as data:image/svg+xml — the
// same data-URI family the working community plugin (and 100milionseek) use.
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">' +
  '<image width="256" height="256" href="data:image/png;base64,' + png + '"/>' +
  "</svg>";
const b64 = Buffer.from(svg, "utf8").toString("base64");

const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
p.version = "0.1.5";
p.magpie.icon = "data:image/svg+xml;base64," + b64;
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");

console.log("version", p.version);
console.log("icon prefix:", p.magpie.icon.slice(0, 40));
console.log("icon total len:", p.magpie.icon.length);
console.log("decoded starts with <svg?", Buffer.from(b64, "base64").toString("utf8").startsWith("<svg"));
