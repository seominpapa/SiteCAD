export function confirmExampleOpen(state, confirm = message => window.confirm(message)) {
  if (state.command || state.modal || state.text_editor || state.mtext_editor) throw Error('진행 중인 CAD 명령과 문자 편집을 마친 뒤 예제를 열어 주세요.');
  const dirty = state.dirty ?? state.documents?.find(item => item.id === state.document_id)?.dirty;
  return dirty === false || confirm('현재 도면에 저장하지 않은 변경이 있거나 저장 상태를 확인하지 못했습니다. 먼저 DWG로 저장하는 것을 권장합니다. 저장하지 않고 예제 도면을 열까요?');
}

export async function exampleFile({ file }) {
  if (typeof file !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.dwg$/.test(file)) throw Error('예제 도면을 다시 선택해 주세요.');
  const response = await fetch(`/api/examples/${file}`);
  if (!response.ok) throw Error('예제 도면을 불러오지 못했습니다. 설치된 예제 파일을 확인해 주세요.');
  if (Number(response.headers.get('Content-Length')) > 30 * 1024 * 1024) throw Error('예제 도면의 용량이 너무 큽니다.');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 30 * 1024 * 1024) throw Error('예제 도면의 용량이 너무 큽니다.');
  return new File([bytes], file);
}

export function createExamples({ isBusy, isReady, onOpen }) {
  const $ = id => document.getElementById(id);
  let loading = false;
  $('examples-close').addEventListener('click', () => $('examples-dialog').close());
  $('open-example').addEventListener('click', async () => {
    if (loading || isBusy() || !isReady()) return;
    loading = true;
    $('examples-list').replaceChildren();
    $('examples-notice').textContent = '예제 도면을 확인하고 있습니다.';
    $('examples-dialog').showModal();
    try {
      const response = await fetch('/api/examples');
      const result = await response.json();
      if (!response.ok || !result.ok) throw Error(result.error || '예제 목록을 불러오지 못했습니다.');
      if (!Array.isArray(result.data?.examples) || !result.data.examples.length) throw Error('설치된 예제 도면이 없습니다.');
      for (const example of result.data.examples) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'example-choice';
        const name = document.createElement('strong'); name.textContent = example.name;
        const description = document.createElement('span'); description.textContent = example.description;
        const filename = document.createElement('small'); filename.textContent = example.file;
        button.append(name, description, filename);
        button.addEventListener('click', async () => {
          if (isBusy() || !isReady()) return;
          $('examples-dialog').close();
          await onOpen(example);
        });
        $('examples-list').append(button);
      }
      $('examples-notice').textContent = '';
    } catch (error) { $('examples-notice').textContent = error.message || '예제를 불러오지 못했습니다.'; }
    finally { loading = false; }
  });
}
