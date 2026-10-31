"use strict";

// 船员日志（crew.log）的轮转与按时间清理。
//
// 现状：每行一条 `[ISO 时间] 内容`，超过 5 MB 轮转成 crew.log.1。
// 问题：轮转在 Windows 上遇到已存在的 crew.log.1 会失败（rename 抛错被吞掉），
//       文件就会一直长大；而且没有任何按时间的清理，几周下来就是几十万行。
//
// 这里提供两个纯函数：
//   rotateIfLarge({dir, maxBytes, keep})  —— 需要时把 crew.log 轮转成带时间戳的名字，并只留最近 keep 份
//   pruneByAge({dir, retentionDays, nowMs}) —— 删掉超过保留期的整份轮转文件，并把 crew.log 里的旧行剪掉

const fs = require("node:fs");
const path = require("node:path");

const LOG_NAME = "crew.log";
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 3;
const DEFAULT_KEEP_ROTATED = 2;
// 轮转出来的文件形如 crew.log.20261020-183000
const ROTATED_PATTERN = /^crew\.log\.(\d{8}-\d{6})$/;

function rotatedPatternFor(baseName) {
  const escaped = String(baseName || LOG_NAME).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\.(\\d{8}-\\d{6})$`);
}

function listRotated(dir, baseName = LOG_NAME) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_error) {
    return [];
  }
  const pattern = rotatedPatternFor(baseName);
  return names
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => ({name, full: path.join(dir, name), stamp: pattern.exec(name)[1]}));
}

function timestampOf(file) {
  const stamp = path.basename(file).replace(/^crew\.log\./, "");
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!match) {
    return 0;
  }
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
}

/** crew.log 超过 maxBytes 就轮转；轮转文件只保留最近 keep 份。 */
function rotateIfLarge(request = {}) {
  const dir = request.dir;
  const maxBytes = Number.isFinite(Number(request.maxBytes)) ? Number(request.maxBytes) : DEFAULT_MAX_BYTES;
  const keep = Number.isFinite(Number(request.keep)) ? Math.max(1, Number(request.keep)) : DEFAULT_KEEP_ROTATED;
  const result = {rotated: false, deletedFiles: 0, path: ""};
  if (!dir) {
    return result;
  }
  const file = path.join(dir, LOG_NAME);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (_error) {
    return result;
  }
  if (!(size > maxBytes)) {
    return result;
  }
  const now = request.nowMs ? new Date(Number(request.nowMs)) : new Date();
  const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`
    + `${String(now.getUTCDate()).padStart(2, "0")}-`
    + `${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}`
    + `${String(now.getUTCSeconds()).padStart(2, "0")}`;
  const target = path.join(dir, `${LOG_NAME}.${stamp}`);
  try {
    fs.renameSync(file, target);
    result.rotated = true;
    result.path = target;
  } catch (_error) {
    // 轮转失败（权限/占用）也不要影响写日志：返回 false，调用方继续 append。
    return result;
  }
  const rotated = listRotated(dir);
  for (const entry of rotated.slice(0, Math.max(0, rotated.length - keep))) {
    try {
      fs.unlinkSync(entry.full);
      result.deletedFiles += 1;
    } catch (_error) {
      /* best effort */
    }
  }
  return result;
}

/** 解析行首的 ISO 时间；解析不出来返回 0（这种行保留）。 */
function lineTimestampMs(line) {
  if (!line || line.charCodeAt(0) !== 91 /* [ */) {
    return 0;
  }
  const close = line.indexOf("]");
  if (close < 0) {
    return 0;
  }
  const parsed = Date.parse(line.slice(1, close));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 删掉过期轮转文件，并把 crew.log 里超过保留期的行剪掉。 */
function pruneByAge(request = {}) {
  const dir = request.dir;
  const retentionDays = Number.isFinite(Number(request.retentionDays))
    ? Number(request.retentionDays)
    : DEFAULT_RETENTION_DAYS;
  const nowMs = Number.isFinite(Number(request.nowMs)) ? Number(request.nowMs) : Date.now();
  const result = {removedLines: 0, keptLines: 0, deletedFiles: 0, skipped: false};
  if (!dir || retentionDays <= 0) {
    result.skipped = true;
    return result;
  }
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const fileName = request.file ? path.basename(String(request.file)) : LOG_NAME;
  const filePath = request.file ? String(request.file) : path.join(dir, LOG_NAME);

  // 1) 过期的轮转文件整份删除
  for (const entry of listRotated(dir, fileName)) {
    if (timestampOf(entry.full) < cutoff) {
      try {
        fs.unlinkSync(entry.full);
        result.deletedFiles += 1;
      } catch (_error) {
        /* best effort */
      }
    }
  }

  // 2) crew.log 里逐行剪掉过期内容
  const file = filePath;
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (_error) {
    return result;
  }
  const lines = text.split("\n");
  const kept = [];
  for (const line of lines) {
    if (!line) {
      continue;
    }
    const stamp = lineTimestampMs(line);
    if (stamp > 0 && stamp < cutoff) {
      result.removedLines += 1;
      continue;
    }
    kept.push(line);
  }
  result.keptLines = kept.length;
  if (result.removedLines === 0) {
    return result;
  }
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf8");
    fs.renameSync(tmp, file);
  } catch (_error) {
    try {
      fs.unlinkSync(tmp);
    } catch (_ignored) {
      /* best effort */
    }
  }
  return result;
}

module.exports = {
  LOG_NAME,
  DEFAULT_MAX_BYTES,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_KEEP_ROTATED,
  ROTATED_PATTERN,
  rotatedPatternFor,
  listRotated,
  lineTimestampMs,
  rotateIfLarge,
  pruneByAge,
};
