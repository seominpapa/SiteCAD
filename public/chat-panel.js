export function createChatPanel() {
  const $ = id => document.getElementById(id);
  const workspace = $('workspace'), panel = $('sitecad-chat-panel'), handle = $('chat-resize');
  let open = true, width, drag;
  const minimum = 320;
  const maximum = () => Math.max(minimum, Math.min(window.innerWidth - 360, 760));
  const canResize = () => open && window.innerWidth > 760;
  const currentWidth = () => width ?? panel.getBoundingClientRect().width;
  function syncSize() {
    handle.setAttribute('aria-valuemin', String(minimum));
    handle.setAttribute('aria-valuemax', String(maximum()));
    handle.setAttribute('aria-valuenow', String(Math.round(currentWidth())));
    handle.setAttribute('aria-valuetext', `채팅창 너비 ${Math.round(currentWidth())}픽셀`);
    handle.setAttribute('aria-disabled', String(!canResize()));
  }
  function resize(value) {
    width = Math.round(Math.max(minimum, Math.min(value, maximum())));
    workspace.style.setProperty('--chat-width', `${width}px`);
    syncSize();
  }
  function stopDrag(event) {
    if (!drag || event && event.pointerId !== drag.id) return;
    const id = drag.id;
    drag = undefined;
    workspace.classList.toggle('chat-resizing', false);
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
  }
  function show(value, focus = false) {
    open = value;
    if (!open) stopDrag();
    workspace.classList.toggle('chat-collapsed', !open);
    panel.hidden = !open;
    handle.hidden = !open;
    $('chat-expand').hidden = open;
    for (const id of ['chat-expand', 'chat-collapse']) $(id).setAttribute('aria-expanded', String(open));
    if (open && width !== undefined && canResize()) resize(width);
    else syncSize();
    if (focus) (open ? $('chat-collapse') : $('chat-expand')).focus();
  }
  $('chat-collapse').addEventListener('click', () => show(false, true));
  $('chat-expand').addEventListener('click', () => show(true, true));
  handle.addEventListener('pointerdown', event => {
    if (!canResize() || drag || event.button !== 0) return;
    event.preventDefault();
    drag = { id: event.pointerId, x: event.clientX, width: currentWidth() };
    handle.setPointerCapture(event.pointerId);
    handle.focus();
    workspace.classList.toggle('chat-resizing', true);
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!canResize()) { stopDrag(); return; }
    resize(drag.width + drag.x - event.clientX);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(name, stopDrag);
  handle.addEventListener('keydown', event => {
    if (!canResize()) return;
    const next = { ArrowLeft: currentWidth() + 20, ArrowRight: currentWidth() - 20, Home: minimum, End: maximum() }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    resize(next);
  });
  window.addEventListener('resize', () => {
    stopDrag();
    if (width !== undefined && canResize()) resize(width);
    else syncSize();
  });
  syncSize();
  return { update(status) { if (status.approvals?.length) show(true); } };
}
