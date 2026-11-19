import test from "node:test";
import assert from "node:assert/strict";
import { tagF1, windowIoU } from "./metrics.ts";

test("tagF1 完全匹配=1，无交集=0", () => {
	assert.equal(tagF1(["a", "b"], ["a", "b"]), 1);
	assert.equal(tagF1(["a"], ["b"]), 0);
	assert.equal(tagF1([], []), 1);
});

test("tagF1 部分匹配", () => {
	assert.equal(tagF1(["a", "b"], ["a", "c"]), 0.5);
});

test("windowIoU 重合/包含/不相交", () => {
	assert.equal(windowIoU([0, 4], [0, 4]), 1);
	assert.equal(windowIoU([0, 4], [2, 6]), 2 / 6);
	assert.equal(windowIoU([0, 2], [3, 5]), 0);
	assert.equal(windowIoU([1, 3], [0, 6]), 2 / 6);
});