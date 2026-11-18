import test from "node:test";
import assert from "node:assert/strict";
import { filterPath } from "./media.ts";

test("filterPath：Windows 盘符冒号双反斜杠转义", () => {
	assert.equal(filterPath("D:\\a\\b.txt"), "D\\\\:/a/b.txt");
	assert.equal(filterPath("C:/Windows/Fonts/msyh.ttc"), "C\\\\:/Windows/Fonts/msyh.ttc");
});

test("filterPath：Unix 路径无冒号保持原样", () => {
	assert.equal(filterPath("/System/Library/Fonts/PingFang.ttc"), "/System/Library/Fonts/PingFang.ttc");
});