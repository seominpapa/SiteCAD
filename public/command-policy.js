// Reviewed against OpenCADStudio 86bf75f: native categories alone include dialogs and system settings.
const creation = Object.freeze([
  'LINE', 'PLINE', 'RECT', 'RECTANG', 'CIRCLE', 'ARC', 'ELLIPSE', 'SPLINE',
  'POINT', 'POLYGON', 'RAY', 'XLINE', 'MLINE', 'HATCH', 'DONUT',
  'SOLID', 'TRACE', 'DIMALIGNED', 'DIMLINEAR',
  'DIMRADIUS', 'DIMDIAMETER', 'DIMANGULAR', 'DIMARC', 'DIMORDINATE', 'DIMJOGGED',
  'DIMJOG', 'MVIEW',
  'BOX', 'CYLINDER', 'CONE', 'SPHERE', 'PYRAMID', 'WEDGE', 'TORUS',
  '3DFACE', '3DPOLY', '3DMESH',
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
  'EXTRUDE', 'PRESSPULL', 'THICKEN', 'REVOLVE', 'SWEEP', 'LOFT',
  'UNION', 'SUBTRACT', 'INTERSECT', 'SLICE', 'FILLETEDGE', 'CHAMFEREDGE', 'SHELL',
  'SOLIDEDIT', '3DMOVE', '3DROTATE', 'ROTATE3D', '3DMIRROR', 'MIRROR3D',
  '3DALIGN', 'ALIGN3D', 'REGION', 'CONVTOSURFACE', 'FLATSHOT', 'POLYSOLID',
]);
const inspection = Object.freeze([
  'DIST', 'ID', 'AREA', 'MEASURE', 'MEASUREGEOM', 'MEASURERADIUS', 'MEASUREANGLE',
  'LIST', 'COUNT', 'ZOOM', 'PAN', 'PLAN', 'REGEN', 'REGENALL', 'REDRAW', 'REDRAWALL',
  'UCS', 'DVIEW',
]);
const styleCommands = ['STYLE', 'DIMSTYLE'];
const viewOptions = Object.freeze({
  VIEW: ['TOP','BOTTOM','FRONT','BACK','LEFT','RIGHT','SWISO','SEISO','NEISO','NWISO','ISO'],
  VISUALSTYLES: ['WIREFRAME2D','WIREFRAME3D','HIDDENLINE','FLATSHADED','GOURAUDSHADED','FLATSHADEDWITHEDGES','GOURAUDSHADEDWITHEDGES'],
});
export const approvedCommands = Object.freeze([...creation, ...editing, ...inspection, ...styleCommands, ...Object.keys(viewOptions)]);
const approved = new Set(approvedCommands);
const createsOnly = new Set(creation);
const blocked = new Set([
  'SAVE', 'QSAVE', 'SAVEAS', 'SAVEALL', 'OPEN', 'NEW', 'QNEW', 'CLOSE', 'CLOSEALL',
  'QUIT', 'EXIT', 'RECOVER', 'RECOVERALL', 'AUDIT', 'PURGE', '-PURGE',
  'WBLOCK', '-WBLOCK', 'PLOT', '-PLOT', 'QUICKPRINT', 'PRINT', 'EXPORT', '-EXPORT',
  'IMPORT', 'PDFIMPORT', '-PDFIMPORT', 'PDFATTACH', 'DGNIMPORT', 'XATTACH', 'XREF',
  '-XREF', 'IMAGEATTACH', 'SCRIPT', 'LISP', 'LOAD', 'APPLOAD', 'NETLOAD', 'PLUGIN',
  'PLUGINS', 'INSTALLPLUGIN', 'BROWSER', 'SETVAR', 'SYSVAR', 'INSUNITS', 'DWGUNITS', 'UNITS',
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
  if (!/^-?(?:[A-Za-z]|3[Dd][A-Za-z])[A-Za-z0-9_]*$/.test(name)) throw Error('명령 검색에서 확인한 전체 명령 이름을 사용해 주세요.');
  return name.toUpperCase();
}

function styleForm(cmd) {
  if (typeof cmd !== 'string') return false;
  const parts = cmd.trim().split(/\s+/);
  return parts.length === 2 && parts[1] === 'LIST' ||
    parts.length === 3 && parts[1] === 'NEW' &&
    /^[\p{L}\p{N}_-]{1,200}$/u.test(parts[2]) &&
    !/^(?:SITECAD_(?:GEOREF|KO|DIM)|SITE_GEOREFERENCE)(?:_|$)/i.test(parts[2]);
}

export function isBlockedCommand(name, cmd) {
  if (styleCommands.includes(name)) return !styleForm(cmd);
  if (Object.hasOwn(viewOptions, name)) {
    const parts = typeof cmd === 'string' ? cmd.trim().split(/\s+/) : [];
    return parts.length !== 2 || cmd.trim() !== parts.join(' ') || !viewOptions[name].includes(parts[1]);
  }
  if (name === 'MVIEW') return typeof cmd === 'string' && /\b(?:I|INSERT|INSERTVIEW)\b/i.test(cmd);
  return typeof name === 'string' && blocked.has(name.toUpperCase());
}

export function commandAccess(manifest, cmd) {
  const name = manifest?.name;
  if (typeof name !== 'string' || !approved.has(name) || (cmd !== undefined && isBlockedCommand(name, cmd))) {
    return { allowed: false, createsOnly: false, reason: name === 'BLOCK' || name === 'BMAKE'
      ? '범용 block_define 작업 또는 -BLOCK 명령을 사용해 주세요.'
      : ['INSERT','-INSERT','MINSERT'].includes(name) ? '외부 파일 경로 대신 entities_create의 Insert로 조회한 블록을 삽입해 주세요.'
      : ['PLOT','-PLOT','EXPORT','-EXPORT','WBLOCK','-WBLOCK'].includes(name) ? '현재 웹 빌드의 파일 출력은 이 경로에서 지원하지 않습니다. DWG는 cad_save로 저장해 주세요.'
      : ['LAYOUT','VPORTS'].includes(name) ? '범용 layout_create, page_setup_set, action/layout_switch 작업을 사용해 주세요.'
      : ['BEDIT','-BEDIT','REFEDIT','REFCLOSE','BCLOSE','BSAVE'].includes(name) ? '블록 편집 세션 대신 records로 블록 구성 객체를 조회하고 set_properties로 수정해 주세요.'
      : 'SiteCAD에서 검토한 2D·3D 명령과 지원 입력만 실행할 수 있습니다. 저장은 cad_save를 사용해 주세요.' };
  }
  if (styleCommands.includes(name)) return { allowed: true, createsOnly: false, runOnly: true, syntax: `${name} LIST | ${name} NEW <name>; 속성 변경은 set_properties, 현재 문자 스타일은 sysvar/ctextstyle` };
  if (Object.hasOwn(viewOptions, name)) return { allowed: true, createsOnly: false, runOnly: true, syntax: `${name} <${viewOptions[name].join('|')}>` };
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
