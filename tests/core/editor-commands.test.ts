import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSourceCommandPatch, commandShortcut, EDITOR_COMMANDS, matchesCommand, shortcutConflict, shortcutForKey, validShortcut,
} from '../../src/core/editor-commands.ts';

function patch(id: keyof typeof EDITOR_COMMANDS, source: string, start: number, end = start) {
  const result = buildSourceCommandPatch(id, source, { start, end, direction: 'forward' });
  assert.ok(result);
  assert.equal(source.slice(result.start, result.end), result.expected);
  return source.slice(0, result.start) + result.insert + source.slice(result.end);
}

test('format commands wrap selections and link target is selected', () => {
  assert.equal(patch('format.bold', 'hello', 0, 5), '**hello**');
  assert.equal(patch('format.italic', 'hello', 0, 5), '*hello*');
  assert.equal(patch('format.italic', '中文词', 1, 2), '中*文*词');
  assert.equal(patch('format.italic', '**中文**', 2, 4), '***中文***');
  assert.equal(patch('format.italic', '***中文***', 3, 5), '**中文**');
  assert.equal(patch('format.inline-code', 'a`b', 0, 3), '``a`b``');
  const link = buildSourceCommandPatch('format.link', 'label', { start: 0, end: 5, direction: 'forward' });
  assert.ok(link);
  assert.equal('label'.slice(0, link.start) + link.insert + 'label'.slice(link.end), '[label](https://example.com)');
  assert.equal(link.selection?.start, 8);
  assert.equal(link.selection?.end, 27);
});

test('line commands preserve line breaks and toggle prefixes', () => {
  assert.equal(patch('paragraph.heading', 'alpha\nbeta', 0, 10), '## alpha\n## beta');
  assert.equal(patch('paragraph.heading', '## alpha', 0, 8), 'alpha');
  assert.equal(patch('paragraph.task', 'alpha', 0, 5), '- [ ] alpha');
  assert.equal(patch('paragraph.bullet', 'one\n\ntwo', 0, 8), '- one\n\n- two');
});

test('block insertions use valid fences and separate adjacent paragraph content', () => {
  assert.equal(patch('insert.table', 'text', 4), 'text\n\n| 列一 | 列二 |\n| --- | --- |\n|  |  |');
  assert.equal(patch('insert.code', '```\ncode', 0, 8), '````\n```\ncode\n````');
  assert.equal(patch('insert.math', 'abc\nx', 0, 5), '$$\nabc\nx\n$$');
});

test('command lookup and shortcut checks normalize platform bindings', () => {
  assert.equal(matchesCommand(EDITOR_COMMANDS['insert.mermaid'], '画流程图'), true);
  assert.equal(commandShortcut(EDITOR_COMMANDS['edit.replace'], {}, true), 'Mod+Alt+F');
  assert.equal(validShortcut('Mod+Shift+P'), true);
  assert.equal(validShortcut('Shift+P'), false);
  assert.ok(shortcutConflict('Mod+Shift+P', 'format.bold', Object.values(EDITOR_COMMANDS), {}, true));
  assert.equal(shortcutForKey({ key: 'p', code: 'KeyP', altKey: false, metaKey: false, ctrlKey: true,
    shiftKey: true, getModifierState: () => false }, true), 'Ctrl+Shift+P');
});
