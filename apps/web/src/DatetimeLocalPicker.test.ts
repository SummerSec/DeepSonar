import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const picker = readFileSync(new URL("./DatetimeLocalPicker.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

test("scheduled start picker uses a clickable calendar and time table", () => {
  assert.match(picker, /datetime-local-trigger/);
  assert.match(picker, /打开选择器/);
  assert.match(picker, /buildMonthCalendar/);
  assert.match(picker, /HOUR_OPTIONS/);
  assert.match(picker, /minuteChoices/);
  assert.match(picker, /aria-label="日期表"/);
  assert.match(picker, /aria-label="小时表"/);
  assert.match(picker, /aria-label="分钟表"/);
  assert.match(picker, /上个月/);
  assert.match(picker, /下个月/);
  assert.match(picker, /isCalendarDateDisabled/);
  assert.match(picker, /isCalendarHourDisabled/);
  assert.match(picker, /isCalendarMinuteDisabled/);
  assert.match(picker, /disabled=\{disabled\}/);
  assert.doesNotMatch(picker, /type="date"/);
  assert.doesNotMatch(picker, /type="time"/);
  assert.doesNotMatch(picker, /type="datetime-local"/);
  assert.doesNotMatch(picker, /\bmin=/);
  assert.doesNotMatch(picker, /setInterval/);
});

test("datetime picker popup stays on theme surfaces instead of native pickers", () => {
  assert.match(picker, /datetime-local-popup theme-drawer/);
  assert.match(styles, /\.datetime-local-grid\.is-days/);
  assert.match(styles, /\.datetime-local-grid\.is-hours/);
  assert.doesNotMatch(styles, /input\[type="date"\]/);
  assert.doesNotMatch(styles, /input\[type="time"\]/);
});
