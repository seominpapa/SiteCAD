import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedCommands, commandName, commandAccess, isBlockedCommand, validateAliases } from '../public/command-policy.js';

test('canonical names allow one bounded command with ordinary arguments', () => {
  assert.equal(commandName('  dimlinear 0,0 100,0 50,20  '), 'DIMLINEAR');
  assert.equal(commandName('-BLOCK'), '-BLOCK');
  assert.equal(commandName('LAYER NEW 검토_도면'), 'LAYER');
  for (const cmd of ['', null, {}, 'LINE\nSAVE', 'LINE\rSAVE', 'LINE\t0,0', 'LINE;SAVE', '.LINE', '_LINE', "'LINE", 'LINE `SAVE`', 'LINE (SAVE)', 'LINE [SAVE]', 'LINE {SAVE}', 'LINE \\SAVE', 'LINE "SAVE"', "LINE 'SAVE'", 'LINE\x00SAVE', 'LINE\x7fSAVE', 'LINE\u2028SAVE', 'LINE\u2029SAVE', 'LINE ' + '0'.repeat(4000)]) {
    assert.throws(() => commandName(cmd), String(cmd));
  }
});

test('only reviewed canonical names are authorized, independent of advertised category', () => {
  for (const name of ['LINE', 'DIMLINEAR', 'DIMALIGNED', 'DIMRADIUS', 'DIMANGULAR']) {
    assert.deepEqual(commandAccess({ name, category: 'other' }), { allowed: true, createsOnly: true });
  }
  for (const name of ['MOVE', 'TRIM', 'CHPROP', '-BLOCK', 'LAYER', 'ZOOM', 'DIST', 'REVCLOUD', 'WIPEOUT', 'DIMCONTINUE', 'DIMBASELINE']) {
    assert.deepEqual(commandAccess({ name, category: 'create' }), { allowed: true, createsOnly: false });
  }
  for (const name of ['L', 'LA', 'CUSTOMCOMMAND', 'DIMUNKNOWN', 'EXTRUDE', '3DPOLY', '.LINE', '_LINE', 'LINE SAVE', 'line']) {
    assert.equal(commandAccess({ name, category: 'create' }).allowed, false, name);
  }
  for (const manifest of [null, {}, { name: 1 }]) assert.equal(commandAccess(manifest).allowed, false);
  assert.equal(new Set(approvedCommands).size, approvedCommands.length);
  assert.ok(Object.isFrozen(approvedCommands));
  for (const name of approvedCommands) assert.equal(commandAccess({ name }).allowed, true, name);
});

test('lifecycle, file access, system variables, plugins and modal-only commands remain blocked', () => {
  for (const name of ['SAVE', 'QSAVE', 'SAVEAS', 'SAVEALL', 'OPEN', 'NEW', 'CLOSE', 'QUIT', 'WBLOCK', '-WBLOCK', 'PLOT', 'EXPORT', 'IMPORT', 'PDFIMPORT', 'SCRIPT', 'LISP', 'APPLOAD', 'SETVAR', 'INSUNITS', 'DWGUNITS', 'UNITS', 'ALIASEDIT', 'DIMSTYLE', 'BLOCK', 'BEDIT', 'BSAVE', 'REFEDIT', 'INSERT', 'TABLE', 'TOLERANCE', 'DDEDIT', 'MTEDIT', 'BROWSER', 'SHELL', 'TEXT', 'MTEXT', 'LEADER', 'QLEADER', 'MLEADER', 'TABLEDIT']) {
    assert.equal(isBlockedCommand(name), true, name);
    assert.equal(commandAccess({ name, category: 'create' }).allowed, false, name);
  }
  assert.match(commandAccess({ name: 'BLOCK' }).reason, /-BLOCK/);
  assert.equal(isBlockedCommand('LINE'), false);
  assert.equal(isBlockedCommand('CUSTOMCOMMAND'), false);
});

test('custom aliases cannot redirect a reviewed command including canonical self aliases', () => {
  const pgp = '; user aliases\nL, *LINE\nLA,*LAYER\nLINE,*SAVE\n';
  assert.throws(() => validateAliases(pgp, 'LINE'), /별칭/);
  assert.throws(() => validateAliases('line, *LINE', 'LINE'), /별칭/);
  assert.throws(() => validateAliases(' line , *OPEN', 'LINE'), /별칭/);
  assert.throws(() => validateAliases('-block,*WBLOCK', '-BLOCK'), /별칭/);
  assert.doesNotThrow(() => validateAliases(pgp, 'LAYER'));
  assert.doesNotThrow(() => validateAliases('; LINE,*SAVE\nL,*LINE\n', 'LINE'));
  assert.doesNotThrow(() => validateAliases(null, 'LINE'));
  assert.doesNotThrow(() => validateAliases('', 'LINE'));
  assert.throws(() => validateAliases({}, 'LINE'));
  assert.throws(() => validateAliases('L,*LINE', '.LINE'));
  assert.throws(() => validateAliases('a'.repeat(1024 * 1024 + 1), 'LINE'));
});
