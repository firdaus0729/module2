const tokenEl = document.getElementById('token');
const storiesEl = document.getElementById('stories');
const detailEl = document.getElementById('detail');

function getToken() {
  return localStorage.getItem('module2_token') || '';
}

function setToken(v) {
  localStorage.setItem('module2_token', v || '');
}

async function api(path) {
  const token = getToken();
  const res = await fetch(path, {
    headers: {
      Authorization: token ? `Bearer ${token}` : '',
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function loadStories() {
  storiesEl.innerHTML = '<p class="muted">Loading...</p>';
  try {
    const stories = await api('/api/stories');
    if (!stories.length) {
      storiesEl.innerHTML = '<p class="muted">No stories yet.</p>';
      detailEl.textContent = 'Select a story';
      return;
    }
    storiesEl.innerHTML = '';
    stories.forEach((s) => {
      const div = document.createElement('div');
      div.className = 'story';
      div.textContent = `${s.title} | ${s.status} | clips ${s.clip_count}`;
      div.onclick = () => loadStoryDetail(s.story_uuid || s.id);
      storiesEl.appendChild(div);
    });
  } catch (e) {
    storiesEl.innerHTML = `<p class="muted">${e.message}</p>`;
  }
}

async function loadStoryDetail(id) {
  detailEl.innerHTML = '<p class="muted">Loading...</p>';
  try {
    const data = await api(`/api/stories/${id}`);
    detailEl.innerHTML = `
      <p><strong>${data.story.title}</strong></p>
      <p class="muted">status: ${data.story.status}</p>
      <p>jobs: ${data.jobs.length}, clips: ${data.clips.length}, transcript segments: ${data.transcript_segments.length}</p>
    `;
  } catch (e) {
    detailEl.innerHTML = `<p class="muted">${e.message}</p>`;
  }
}

document.getElementById('saveToken').onclick = () => {
  setToken(tokenEl.value.trim());
  alert('Token saved');
};

document.getElementById('loadStories').onclick = () => {
  loadStories();
};

tokenEl.value = getToken();
