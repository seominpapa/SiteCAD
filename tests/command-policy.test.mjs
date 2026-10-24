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
  for (const name of ['L', 'LA', 'CUSTOMCOMMAND', 'DIMUNKNOWN', '3DUNKNOWN', '.LINE', '_LINE', 'LINE SAVE', 'line']) {
    assert.equal(commandAccess({ name, category: 'create' }).allowed, false, name);
  }
  for (const manifest of [null, {}, { name: 1 }]) assert.equal(commandAccess(manifest).allowed, false);
  assert.equal(new Set(approvedCommands).size, approvedCommands.length);
  assert.ok(Object.isFrozen(approvedCommands));
  for (const name of approvedCommands) assert.equal(commandAccess({ name }).allowed, true, name);
});

test('native 3D commands distinguish additive primitives from operations that can change existing geometry', () => {
  for (const name of ['BOX','CYLINDER','CONE','SPHERE','PYRAMID','WEDGE','TORUS','3DFACE','3DPOLY','3DMESH']) {
    assert.deepEqual(commandAccess({name,category:'other'}),{allowed:true,createsOnly:true},name);
  }
  for (const name of ['POLYSOLID','EXTRUDE','PRESSPULL','THICKEN','REVOLVE','SWEEP','LOFT','UNION','SUBTRACT','INTERSECT','SLICE','FILLETEDGE','CHAMFEREDGE','SHELL','SOLIDEDIT','3DMOVE','3DROTATE','ROTATE3D','3DMIRROR','MIRROR3D','3DALIGN','ALIGN3D','REGION','CONVTOSURFACE','FLATSHOT','UCS','DVIEW']) {
    assert.deepEqual(commandAccess({name,category:'create'}),{allowed:true,createsOnly:false},name);
  }
  assert.equal(commandName('3dpoly 10,20,30 40,50,60'),'3DPOLY');
  for (const name of ['3D','3','4DROTATE','123BOX','3D_LINE','3DPOLY;SAVE','3DPOLY\nSAVE']) assert.throws(()=>commandName(name),name);
  assert.throws(()=>validateAliases('3DPOLY,*SAVE','3DPOLY'),/별칭/);
});

test('3D views allow bounded native presets without opening dialogs or accepting arbitrary options', () => {
  for (const [name,forms] of [['VIEW',['TOP','BOTTOM','FRONT','BACK','LEFT','RIGHT','SWISO','SEISO','NEISO','NWISO','ISO']],['VISUALSTYLES',['WIREFRAME2D','WIREFRAME3D','HIDDENLINE','FLATSHADED','GOURAUDSHADED','FLATSHADEDWITHEDGES','GOURAUDSHADEDWITHEDGES']]]) {
    assert.equal(commandAccess({name}).runOnly,true);
    for(const form of forms) {
      assert.equal(commandAccess({name},`${name} ${form}`).allowed,true);
      assert.equal(isBlockedCommand(name,`${name} ${form}`),false);
    }
    for(const cmd of [name,`${name} DIALOG`,`${name} UNKNOWN`,`${name} TOP extra`,`${name} TOP;SAVE`,`${name}  ${forms[0]}`,`${name}\t${forms[0]}`]) {
      assert.equal(isBlockedCommand(name,cmd),true,cmd);
      assert.equal(commandAccess({name},cmd).allowed,false,cmd);
    }
  }
});

test('lifecycle, file access, system variables, plugins and modal-only commands remain blocked', () => {
  for (const name of ['SAVE', 'QSAVE', 'SAVEAS', 'SAVEALL', 'OPEN', 'NEW', 'CLOSE', 'QUIT', 'WBLOCK', '-WBLOCK', 'PLOT', 'EXPORT', 'IMPORT', 'PDFIMPORT', 'SCRIPT', 'LISP', 'APPLOAD', 'SETVAR', 'INSUNITS', 'DWGUNITS', 'UNITS', 'ALIASEDIT', 'BLOCK', 'BEDIT', 'BSAVE', 'REFEDIT', 'INSERT', 'TABLE', 'TOLERANCE', 'DDEDIT', 'MTEDIT', 'BROWSER', 'TEXT', 'MTEXT', 'LEADER', 'QLEADER', 'MLEADER', 'TABLEDIT']) {
    assert.equal(isBlockedCommand(name), true, name);
    assert.equal(commandAccess({ name, category: 'create' }).allowed, false, name);
  }
  assert.match(commandAccess({ name: 'BLOCK' }).reason, /-BLOCK/);
  assert.equal(isBlockedCommand('LINE'), false);
  assert.equal(isBlockedCommand('CUSTOMCOMMAND'), false);
});

test('existing nonmodal style commands are available without enabling their dialogs or font paths', () => {
  for (const name of ['STYLE', 'DIMSTYLE']) {
    assert.equal(commandAccess({ name }).runOnly, true);
    for (const cmd of [`${name} LIST`, `${name} NEW 현장_검토`]) {
      assert.equal(isBlockedCommand(name, cmd), false, cmd);
      assert.equal(commandAccess({ name }, cmd).allowed, true, cmd);
    }
    for (const cmd of [name, `${name} SET 검토_스타일`, `${name} DIALOG`, `${name} FONT x /private/font.ttf`, `${name} NEW SITECAD_GEOREF`, `${name} NEW x extra`, `${name} NEW x;SAVE`, `${name} NEW SiteCAD_DIM`]) {
      assert.equal(isBlockedCommand(name, cmd), true, cmd);
      assert.equal(commandAccess({ name }, cmd).allowed, false, cmd);
    }
  }
  assert.match(commandAccess({name:'INSERT'}).reason, /entities_create/);
  assert.match(commandAccess({name:'PLOT'}).reason, /웹/);
});

test('viewport creation excludes native insert-view branches that switch layouts internally', () => {
  for(const cmd of ['MVIEW','MVIEW 0,0 100,100','MVIEW FIT'])assert.equal(isBlockedCommand('MVIEW',cmd),false);
  for(const cmd of ['MVIEW I','MVIEW INSERT','MVIEW INSERTVIEW','MVIEW INSERT VIEW'])assert.equal(isBlockedCommand('MVIEW',cmd),true);
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
