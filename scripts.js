const clientId = 'gky3gvnl2o5v2x26xrw5i79hs17nrk';
const accessToken = 'iixlwx182vg4jbrhtv2hpwnxbfas5m'; // Must be valid Bearer token
//const clientId = 'YOUR_CLIENT_ID_HERE'; // Replace with your Twitch Client ID
//const accessToken = 'YOUR_ACCESS_TOKEN_HERE'; // Replace with your Twitch Bearer Token
const tableBody = document.querySelector('#streamers-table tbody');
const tableHeaders = document.querySelectorAll('#streamers-table th');

const loadingSpinner = document.querySelector('#loading-spinner');
let streams = [];
let sortedStreams = [];
let currentSort = { column: 'viewer_count', direction: 'desc' };
let currentStreamIndex = -1;
let currentStreamLogin = null;
let isPlayerOpen = false;
const CACHE_KEY = 'twitch_streams_cache';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchWithRetry(url, options, retries = 2, backoff = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Ratelimit-Reset')) || backoff;
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP error: ${response.status} for ${url}`);
      return await response.json();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, backoff * (i + 1)));
    }
  }
}

function formatUptime(startedAt) {
  if (!startedAt) return 'N/A';
  const start = new Date(startedAt);
  const now = new Date();
  const diffMs = now - start;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function getCachedData() {
  const cached = localStorage.getItem(CACHE_KEY);
  if (!cached) return null;
  const { data, timestamp } = JSON.parse(cached);
  if (Date.now() - timestamp > CACHE_TTL) {
    localStorage.removeItem(CACHE_KEY);
    return null;
  }
  // Ensure viewer_rank is set for cached data
  data.sort((a, b) => b.viewer_count - a.viewer_count);
  data.forEach((stream, index) => {
    stream.viewer_rank = index + 1;
    console.log(`Cached rank for ${stream.user_name}: ${stream.viewer_rank}`); // Debug
  });
  return data;
}

function setCachedData(data) {
  localStorage.setItem(CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
}

async function fetchTopStreams(forceCache = false) {
  try {
    // Show spinner
    if (loadingSpinner) loadingSpinner.style.display = 'block';
    tableBody.innerHTML = '';

    // Clear cache if forced
    if (forceCache) {
      localStorage.removeItem(CACHE_KEY);
      console.log('Cache cleared for refresh');
    }

    // Check cache
    const cachedStreams = getCachedData();
    if (cachedStreams && !forceCache) {
      streams = cachedStreams;
      sortAndRender();
      if (streams.length > 0) {
        openPlayer(0);
      }
      return;
    }

    streams = [];

    // Fetch streams (up to 200)
    let cursor = null;
    for (let i = 0; i < 5; i++) {
      const url = new URL('https://api.twitch.tv/helix/streams');
      url.searchParams.set('first', '100');
      if (cursor) url.searchParams.set('after', cursor);

      console.log(`Fetching streams page ${i + 1}`);
      const data = await fetchWithRetry(url.toString(), {
        headers: {
          'Client-ID': clientId,
          'Authorization': `Bearer ${accessToken}`
        }
      });

      streams.push(...data.data.map(stream => ({
        user_id: stream.user_id,
        user_name: stream.user_name,
        user_login: stream.user_login,
        viewer_count: stream.viewer_count,
        game_name: stream.game_name || 'Unknown',
        started_at: stream.started_at,
        followers: null,
        profile_image_url: null,
        viewer_rank: null
      })));

      cursor = data.pagination.cursor;
      if (!cursor || streams.length >= 200) break;
    }

    // Assign viewer ranks based on viewer count
    streams.sort((a, b) => b.viewer_count - a.viewer_count);
    streams.forEach((stream, index) => {
      stream.viewer_rank = index + 1;
      console.log(`Assigned rank for ${stream.user_name}: ${stream.viewer_rank}`); // Debug
    });

    // Fetch profile images
    const userLogins = streams.map(s => s.user_login);
    for (let i = 0; i < userLogins.length; i += 100) {
      const batch = userLogins.slice(i, i + 100);
      const url = new URL('https://api.twitch.tv/helix/users');
      batch.forEach(login => url.searchParams.append('login', login));
      console.log(`Fetching user profiles for batch ${i / 100 + 1}`);
      const data = await fetchWithRetry(url.toString(), {
        headers: {
          'Client-ID': clientId,
          'Authorization': `Bearer ${accessToken}`
        }
      });

      data.data.forEach(user => {
        const stream = streams.find(s => s.user_login === user.login);
        if (stream) stream.profile_image_url = user.profile_image_url;
      });
    }

    // Fetch follower counts in parallel batches
    const batchSize = 50;
    for (let i = 0; i < streams.length; i += batchSize) {
      const batch = streams.slice(i, i + batchSize);
      console.log(`Fetching followers for batch ${i / 100 + 1}`);
      const promises = batch.map(async stream => {
        try {
          const url = new URL('https://api.twitch.tv/helix/channels/followers');
          url.searchParams.set('broadcaster_id', stream.user_id);
          const data = await fetchWithRetry(url.toString(), {
            headers: {
              'Client-ID': clientId,
              'Authorization': `Bearer ${accessToken}`
            }
          });
          stream.followers = data.total || 0;
        } catch (error) {
          console.error(`Failed to fetch followers for ${stream.user_name}: ${error.message}`);
          stream.followers = 'N/A';
        }
      });
      await Promise.allSettled(promises);
    }

    // Cache data
    setCachedData(streams);

    // Render
    sortAndRender();
    
    // Auto-load first stream
    if (streams.length > 0) {
      openPlayer(0);
    }

  } catch (error) {
    console.error('Error fetching streams:', error);
    tableBody.innerHTML = `<tr><td colspan="8">Error loading streams: ${error.message}</td></tr>`;
  } finally {
    // Hide spinner
    if (loadingSpinner) loadingSpinner.style.display = 'none';
  }
}

function sortAndRender() {
  const { column, direction } = currentSort;
  sortedStreams = [...streams].sort((a, b) => {
    let valA = a[column];
    let valB = b[column];
    
    if (column === 'viewer_count' || column === 'user_id') {
      valA = Number(valA) || 0;
      valB = Number(valB) || 0;
      return direction === 'asc' ? valA - valB : valB - valA;
    }
    
    if (column === 'followers') {
      valA = valA === 'N/A' ? -1 : Number(valA);
      valB = valB === 'N/A' ? -1 : Number(valB);
      return direction === 'asc' ? valA - valB : valB - valA;
    }
    
    if (column === 'uptime') {
      valA = a.started_at ? new Date(a.started_at).getTime() : Infinity;
      valB = b.started_at ? new Date(b.started_at).getTime() : Infinity;
      return direction === 'asc' ? valA - valB : valB - valA;
    }
    
    return direction === 'asc'
      ? (valA || '').localeCompare(valB || '')
      : (valB || '').localeCompare(valA || '');
  }).slice(0, 200);

  tableBody.innerHTML = '';
  sortedStreams.forEach((stream, index) => {
    const row = document.createElement('tr');
    // Apply color-coding class to Rank column
    let rankClass = '';
    if (stream.viewer_rank <= 3) {
      rankClass = 'rank-top-3';
    } else if (stream.viewer_rank >= 7 && stream.viewer_rank <= 10) {
      rankClass = 'rank-7-10';
    } else if (stream.viewer_rank >= 11 && stream.viewer_rank <= 50) {
      rankClass = 'rank-11-50';
    } else if (stream.viewer_rank >= 51 && stream.viewer_rank <= 100) {
      rankClass = 'rank-51-100';
    } else {
      rankClass = 'rank-101-plus';
    }

    row.setAttribute('data-user-login', stream.user_login);
    row.innerHTML = `
      <td class="${rankClass}">${stream.viewer_rank || 'N/A'}</td>
      <td title="${stream.user_name}">
        ${stream.profile_image_url ? `<img class="profile-img" src="${stream.profile_image_url}" alt="${stream.user_name}"/>` : ''}
        ${stream.user_name}
        <button class="watch-btn" onclick="openPlayer(${index})">Watch</button>
      </td>
      <td>${stream.user_id}</td>
      <td>${stream.viewer_count.toLocaleString()}</td>
      <td>${stream.game_name}</td>
      <td>${stream.followers === 'N/A' ? 'N/A' : stream.followers.toLocaleString()}</td>
      <td>${formatUptime(stream.started_at)}</td>
      <td>
        <a href="https://twitch.tv/${stream.user_login}" target="_blank">Visit Channel</a>
      </td>
    `;
    tableBody.appendChild(row);
  });

  // Update currentStreamIndex if player is open
  if (isPlayerOpen && currentStreamLogin) {
    const newIndex = sortedStreams.findIndex(s => s.user_login === currentStreamLogin);
    if (newIndex !== -1) {
      currentStreamIndex = newIndex;
    }
  }

  // Update arrows
  tableHeaders.forEach(header => {
    const arrow = header.querySelector('.sort-arrow');
    const sortColumn = header.getAttribute('data-sort');
    if (sortColumn === column) {
      arrow.textContent = direction === 'asc' ? '↑' : '↓';
    } else {
      arrow.textContent = '';
    }
  });
  
  // Highlight and scroll to current stream if player is open
  if (isPlayerOpen) {
    setTimeout(() => {
      highlightCurrentStream();
    }, 50);
  }
}

tableHeaders.forEach(header => {
  header.addEventListener('click', () => {
    const column = header.getAttribute('data-sort');
    if (currentSort.column === column) {
      currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      currentSort.column = column;
      currentSort.direction = column === 'viewer_count' || column === 'followers' ? 'desc' : 'asc';
    }
    sortAndRender();
  });
});





function openPlayerByStream(userLogin) {
  const index = sortedStreams.findIndex(s => s.user_login === userLogin);
  if (index !== -1) {
    openPlayer(index);
  }
}

function openPlayer(index) {
  currentStreamIndex = index;
  const stream = sortedStreams[index];
  currentStreamLogin = stream.user_login;
  document.getElementById('current-streamer').textContent = stream.user_name;
  
  // Show video player first to meet Twitch visibility requirements
  document.getElementById('video-player').style.display = 'block';
  
  // Scroll into view to meet viewport visibility requirement
  document.getElementById('video-player').scrollIntoView({ behavior: 'smooth', block: 'center' });
  
  const iframe = document.getElementById('twitch-embed');
  
  // Wait for iframe to be fully rendered and visible
  requestAnimationFrame(() => {
    setTimeout(() => {
          const parent = window.location.hostname || 'localhost';
      iframe.src = `https://player.twitch.tv/?channel=${stream.user_login}&parent=${parent}&preload=auto&time=0s`;
    }, 500);
  });
  
  iframe.onload = function() {
    try {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
      const style = iframeDoc.createElement('style');
      style.textContent = '[data-a-target="player-overlay-ads"], .ads-overlay, [class*="ad"], [id*="ad"] { display: none !important; }';
      iframeDoc.head.appendChild(style);
    } catch(e) {}
  };
  
  isPlayerOpen = true;
  setTimeout(highlightCurrentStream, 0);
}

function closePlayer() {
  document.getElementById('video-player').style.display = 'none';
  document.getElementById('twitch-embed').src = '';
  clearHighlight();
  isPlayerOpen = false;
  currentStreamIndex = -1;
  currentStreamLogin = null;
}

function highlightCurrentStream() {
  clearHighlight();
  if (currentStreamIndex >= 0 && currentStreamIndex < sortedStreams.length) {
    const currentStream = sortedStreams[currentStreamIndex];
    const targetRow = document.querySelector(`tr[data-user-login="${currentStream.user_login}"]`);
    
    if (targetRow) {
      targetRow.classList.add('currently-playing');
      targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

function clearHighlight() {
  document.querySelectorAll('.currently-playing').forEach(row => {
    row.classList.remove('currently-playing');
  });
}

function nextStream() {
  if (currentStreamIndex < sortedStreams.length - 1) {
    preloadStream(currentStreamIndex + 2);
    openPlayer(currentStreamIndex + 1);
  }
}

function prevStream() {
  if (currentStreamIndex > 0) {
    openPlayer(currentStreamIndex - 1);
  }
}

function preloadStream(index) {
  if (index < sortedStreams.length) {
    const link = document.createElement('link');
    link.rel = 'preload';
    link.href = `https://player.twitch.tv/?channel=${sortedStreams[index].user_login}&parent=${window.location.hostname}`;
    link.as = 'document';
    document.head.appendChild(link);
    setTimeout(() => document.head.removeChild(link), 5000);
  }
}

document.getElementById('close-player').addEventListener('click', closePlayer);
document.getElementById('next-stream').addEventListener('click', nextStream);
document.getElementById('prev-stream').addEventListener('click', prevStream);

document.getElementById('main-title').addEventListener('click', () => {
  fetchTopStreams(true);
});



async function checkUserLogin() {
  try {
    const response = await fetch('https://oauth2.twitch.tv/validate', {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.login) {
        document.getElementById('logged-in-user').innerHTML = `App authenticated as: <strong>${data.login}</strong>`;
      } else {
        document.getElementById('logged-in-user').textContent = 'Using app token';
      }
    } else {
      document.getElementById('logged-in-user').textContent = 'Token invalid';
    }
  } catch (error) {
    document.getElementById('logged-in-user').textContent = 'Using app token';
  }
}

// Particle effect
const canvas = document.getElementById('particles');
const ctx = canvas.getContext('2d');
let particles = [];

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

function createParticle() {
  return {
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    vx: (Math.random() - 0.5) * 0.5,
    vy: (Math.random() - 0.5) * 0.5,
    size: Math.random() * 2 + 1,
    opacity: Math.random() * 0.5 + 0.2
  };
}

function initParticles() {
  particles = [];
  for (let i = 0; i < 50; i++) {
    particles.push(createParticle());
  }
}

function updateParticles() {
  particles.forEach(particle => {
    particle.x += particle.vx;
    particle.y += particle.vy;
    
    if (particle.x < 0 || particle.x > canvas.width) particle.vx *= -1;
    if (particle.y < 0 || particle.y > canvas.height) particle.vy *= -1;
  });
}

function drawParticles() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  particles.forEach(particle => {
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(145, 70, 255, ${particle.opacity})`;
    ctx.fill();
  });
  
  // Draw connections
  particles.forEach((particle, i) => {
    particles.slice(i + 1).forEach(otherParticle => {
      const dx = particle.x - otherParticle.x;
      const dy = particle.y - otherParticle.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance < 100) {
        ctx.beginPath();
        ctx.moveTo(particle.x, particle.y);
        ctx.lineTo(otherParticle.x, otherParticle.y);
        ctx.strokeStyle = `rgba(145, 70, 255, ${0.1 * (1 - distance / 100)})`;
        ctx.stroke();
      }
    });
  });
}

function animate() {
  updateParticles();
  drawParticles();
  requestAnimationFrame(animate);
}

resizeCanvas();
initParticles();
animate();

window.addEventListener('resize', () => {
  resizeCanvas();
  initParticles();
});

checkUserLogin();
fetchTopStreams();
