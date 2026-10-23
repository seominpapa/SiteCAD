// Reviewed against OpenCADStudio 86bf75f: native categories alone include dialogs and system settings.
const creation = Object.freeze([
  'LINE', 'PLINE', 'RECT', 'RECTANG', 'CIRCLE', 'ARC', 'ELLIPSE', 'SPLINE',
  'POINT', 'POLYGON', 'RAY', 'XLINE', 'MLINE', 'HATCH', 'DONUT',
  'SOLID', 'TRACE', 'DIMALIGNED', 'DIMLINEAR',
  'DIMRADIUS', 'DIMDIAMETER', 'DIMANGULAR', 'DIMARC', 'DIMORDINATE', 'DIMJOGGED',
  'DIMJOG',
]);
const editing = Object.freeze([
  'MOVE', 'COPY', 'ROTATE', 'SCALE', 'MIRROR', 'ERASE', 'TRIM', 'EXTEND', 'OFFSET',
  'REVCLOUD', 'WIPEOUT', 'DIMCONTINUE', 'DIMBASELINE',
  'FILLET', 'CHAMFER', 'BREAK', 'BREAKATPOINT', 'JOIN', 'EXPLODE', 'TXTEXP',
  'STRETCH', 'ARRAY', 'ARRAYRECT', 'ARRAYPOLAR', 'ARRAYPATH', 'PEDIT', 'SPLINEDIT',
  'REVERSE', 'ALIGN', 'BLEND', 'CHPROP', 'MATCHPROP',
  'JUSTIFYTEXT', 'TCASE', 'TEXTMASK', 'TEXTFIT', 'TCOUNT', 'TXT2MTXT',
  'DIMEDIT', 'DIMTEDIT', 'DIMBREAK', 'DIMSPACE', 'DIMJOGLINE', 'MLEADERADD',
  'MLEADERREMOVE', 'MLEADERALIGN', 'MLEADERCOLLECT', 'QDIM', '-BLOCK', 'ATTSYNC',
  'LAYER', 'LAYOFF', 'LAYFRZ', 'LAYLCK', 'LAYMCUR', 'LAYON', 'LAYTHW', 'LAYULK',
  'LAYISO', 'LAYUNISO', 'LAYCUR', 'LAYMATCH', 'GROUP', 'UNGROUP', 'DRAWORDER',
  'HATCHTOBACK', 'ISOLATEOBJECTS', 'HIDEOBJECTS', 'UNISOLATEOBJECTS',
]);
const inspection = Object.freeze([
  'DIST', 'ID', 'AREA', 'MEASURE', 'MEASUREGEOM', 'MEASURERADIUS', 'MEASUREANGLE',
  'LIST', 'COUNT', 'ZOOM', 'PAN', 'PLAN', 'REGEN', 'REGENALL', 'REDRAW', 'REDRAWALL',
]);
export const approvedCommands = Object.freeze([...creation, ...editing, ...inspection]);
const approved = new Set(approvedCommands);
const createsOnly = new Set(creation);
const blocked = new Set([
  'SAVE', 'QSAVE', 'SAVEAS', 'SAVEALL', 'OPEN', 'NEW', 'QNEW', 'CLOSE', 'CLOSEALL',
  'QUIT', 'EXIT', 'RECOVER', 'RECOVERALL', 'AUDIT', 'PURGE', '-PURGE',
  'WBLOCK', '-WBLOCK', 'PLOT', '-PLOT', 'QUICKPRINT', 'PRINT', 'EXPORT', '-EXPORT',
  'IMPORT', 'PDFIMPORT', '-PDFIMPORT', 'PDFATTACH', 'DGNIMPORT', 'XATTACH', 'XREF',
  '-XREF', 'IMAGEATTACH', 'SCRIPT', 'LISP', 'LOAD', 'APPLOAD', 'NETLOAD', 'PLUGIN',
  'PLUGINS', 'INSTALLPLUGIN', 'BROWSER', 'SHELL', 'SETVAR', 'SYSVAR', 'INSUNITS', 'DWGUNITS', 'UNITS',
  'LUNITS', 'AUNITS', 'FILEDIA', 'CMDDIA', 'ALIASEDIT', 'SHORTCUTEDIT', 'OPTIONS',
  'BLOCK', 'BMAKE', 'BEDIT', '-BEDIT', 'BCLOSE', 'BSAVE', 'BSAVEAS', 'BTESTBLOCK',
  'REFEDIT', 'REFCLOSE', 'INSERT', '-INSERT', 'MINSERT', 'DIMSTYLE', 'DDIM',
  'STYLE', 'TEXTSTYLE', 'TABLESTYLE', 'MLEADERSTYLE', 'LAYOUT', 'VPORTS', 'MVIEW',
  'TABLE', 'TOLERANCE', 'DDEDIT', 'MTEDIT', 'TEXT', 'MTEXT', 'LEADER', 'QLEADER', 'MLEADER', 'TABLEDIT',
]);

export function commandName(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim() || cmd.length > 4000 ||
    /[\x00-\x1f\x7f\u2028\u2029;\\"'`()[\]{}]/.test(cmd)) {
    throw Error('하나의 CAD 명령과 올바른 입력만 전달해 주세요.');
  }
  const name = cmd.trim().split(' ')[0];
  if (!/^-?[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw Error('명령 검색에서 확인한 전체 명령 이름을 사용해 주세요.');
  return name.toUpperCase();
}

export function isBlockedCommand(name) {
  return typeof name === 'string' && blocked.has(name.toUpperCase());
}

export function commandAccess(manifest) {
  const name = manifest?.name;
  if (typeof name !== 'string' || !approved.has(name)) {
    return { allowed: false, createsOnly: false, reason: name === 'BLOCK' || name === 'BMAKE'
      ? '대화상자 대신 -BLOCK 명령을 사용해 주세요.'
      : 'SiteCAD에서 검토한 2D 명령만 실행할 수 있습니다. 저장은 cad_save를 사용해 주세요.' };
  }
  return { allowed: true, createsOnly: createsOnly.has(name) };
}

export function validateAliases(pgp, name) {
  if (commandName(name) !== name) throw Error('전체 명령 이름을 확인해 주세요.');
  if (pgp == null) return;
  if (typeof pgp !== 'string' || pgp.length > 1024 * 1024) throw Error('편집기 명령 별칭을 확인하지 못했습니다.');
  // Canonical names can also be aliases; refuse overrides instead of guessing their dispatch behavior.
  if (pgp.split(/\r?\n/).some(line => !line.trimStart().startsWith(';') && line.includes(',') &&
    line.slice(0, line.indexOf(',')).trim().toUpperCase() === name)) {
    throw Error('전체 명령 이름에 사용자 별칭이 등록되어 실행을 중단했습니다. 편집기에서 해당 별칭을 확인해 주세요.');
  }
}
