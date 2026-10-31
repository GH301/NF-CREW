"use strict";

// Client fitting XML reader.
//
// Format written by the EVE client's "Export fitting" (Documents\EVE\fittings):
//
//   <fitting name="*挖矿">
//     <description value=""/>
//     <shipType value="妄想级"/>
//     <hardware slot="hi slot 0" type="外空联合矿业露天采矿器"/>
//     <hardware qty="5" slot="drone bay" type="收割者采矿无人机"/>
//   </fitting>
//
// Notes that matter:
//   * one file can hold hundreds of <fitting> blocks
//   * names are localised (Chinese here) — resolution happens later, in the SDE
//   * loaded charges are usually NOT exported, so a hardware entry may have no
//     <charge> child even when the module needs one
//   * slot strings are 0-based per family: "hi slot 0" ... "hi slot 7"

const SLOT_FAMILIES = Object.freeze({
  low: {prefix: "low slot", base: 11, count: 8},
  med: {prefix: "med slot", base: 19, count: 8},
  hi: {prefix: "hi slot", base: 27, count: 8},
  rig: {prefix: "rig slot", base: 92, count: 8},
  subsystem: {prefix: "subsystem slot", base: 125, count: 8},
  service: {prefix: "service slot", base: 164, count: 8},
});

// Named bays/holds that appear in exports.
const NAMED_SLOTS = Object.freeze({
  "drone bay": 87,
  cargo: 5,
  "cargo hold": 5,
  "fighter bay": 158,
  "fuel bay": 133,
  "ship hangar": 90,
});

function unescapeXml(value) {
  return String(value == null ? "" : value)
    .replace(/&#(\d+);/gu, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

/** Read the attributes of a single tag body (e.g. `slot="hi slot 0" type="X"`). */
function readAttributes(tagBody) {
  const attributes = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/gu;
  let match = pattern.exec(tagBody);
  while (match) {
    attributes[match[1].toLowerCase()] = unescapeXml(match[2]);
    match = pattern.exec(tagBody);
  }
  return attributes;
}

/**
 * Map a client slot string to the server's flagID.
 * Returns {flagID, family, index} or {error}.
 */
function resolveSlot(slotText) {
  const text = String(slotText == null ? "" : slotText).trim().toLowerCase();
  if (!text) {
    return {error: "EMPTY_SLOT"};
  }
  if (Object.prototype.hasOwnProperty.call(NAMED_SLOTS, text)) {
    return {flagID: NAMED_SLOTS[text], family: text, index: 0};
  }
  for (const [family, definition] of Object.entries(SLOT_FAMILIES)) {
    if (!text.startsWith(definition.prefix)) {
      continue;
    }
    const index = Number(text.slice(definition.prefix.length).trim());
    if (!Number.isInteger(index) || index < 0 || index >= definition.count) {
      return {error: "BAD_SLOT_INDEX", slot: slotText};
    }
    return {flagID: definition.base + index, family, index};
  }
  return {error: "UNKNOWN_SLOT", slot: slotText};
}

const FITTING_BLOCK = /<fitting\b([^>]*)>([\s\S]*?)<\/fitting>/gu;
const HARDWARE_BLOCK = /<hardware\b([^>]*?)(\/>|>([\s\S]*?)<\/hardware>)/gu;

/** Parse every <fitting> in the text. Malformed blocks are reported, not thrown. */
function parseFittings(xmlText) {
  const text = String(xmlText == null ? "" : xmlText);
  const fittings = [];
  const errors = [];
  FITTING_BLOCK.lastIndex = 0;
  let block = FITTING_BLOCK.exec(text);
  while (block) {
    const header = readAttributes(block[1] || "");
    const body = block[2] || "";
    const name = String(header.name || "").trim();
    if (!name) {
      errors.push({error: "FITTING_WITHOUT_NAME"});
      block = FITTING_BLOCK.exec(text);
      continue;
    }
    const description = readAttributes((/<description\b([^>]*)\/?>/u.exec(body) || [null, ""])[1] || "");
    const shipType = readAttributes((/<shipType\b([^>]*)\/?>/u.exec(body) || [null, ""])[1] || "");
    const hardware = [];
    HARDWARE_BLOCK.lastIndex = 0;
    let entry = HARDWARE_BLOCK.exec(body);
    while (entry) {
      const attributes = readAttributes(entry[1] || "");
      const inner = entry[3] || "";
      const slot = resolveSlot(attributes.slot);
      const chargeMatch = /<charge\b([^>]*?)\/?>/u.exec(inner);
      const charge = chargeMatch ? readAttributes(chargeMatch[1] || "") : null;
      hardware.push({
        slot: String(attributes.slot || ""),
        type: String(attributes.type || "").trim(),
        qty: attributes.qty ? Number(attributes.qty) : 1,
        charge: charge && charge.type ? {type: String(charge.type).trim(), qty: Number(charge.qty || 1)} : null,
        slotFlagID: slot.flagID === undefined ? null : slot.flagID,
        slotFamily: slot.family || null,
        slotError: slot.error || null,
      });
      entry = HARDWARE_BLOCK.exec(body);
    }
    fittings.push({
      name,
      description: String(description.value || ""),
      shipType: String(shipType.value || "").trim(),
      hardware,
    });
    block = FITTING_BLOCK.exec(text);
  }
  return {fittings, errors};
}

/** Find one fitting by exact name (case/space sensitive, NFKC-normalised). */
function findFitting(xmlText, name) {
  const wanted = String(name == null ? "" : name).normalize("NFKC").trim();
  const {fittings} = parseFittings(xmlText);
  const matches = fittings.filter((fitting) => fitting.name.normalize("NFKC").trim() === wanted);
  if (matches.length === 0) {
    return {fitting: null, matches: []};
  }
  return {fitting: matches[0], matches};
}

module.exports = {
  SLOT_FAMILIES,
  NAMED_SLOTS,
  parseFittings,
  findFitting,
  resolveSlot,
  readAttributes,
  unescapeXml,
};
