/* Session */

let sessionId = localStorage.getItem('mcp_session_id') || uuidv4();
localStorage.setItem('mcp_session_id', sessionId);

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

/* DOM refs */
const chatBox = document.getElementById('chat-box');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const newChatBtn = document.getElementById('new-chat');
const dbSelector = document.getElementById('db-selector');
const typingIndicator = document.getElementById('typing-indicator');

/*  Marked config */
marked.setOptions({
    breaks: true,
    highlight(code, lang) {
        if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
        return hljs.highlightAuto(code).value;
    }
});

/* Abort */
let activeAbortController = null;

function setStreaming(active) {
    sendBtn.classList.toggle('hidden', active);
    stopBtn.classList.toggle('hidden', !active);
    userInput.disabled = active;
    typingIndicator.classList.toggle('hidden', !active);
}

stopBtn.addEventListener('click', () => {
    activeAbortController?.abort();
    activeAbortController = null;
    setStreaming(false);
});

/*  New chat  */
newChatBtn.addEventListener('click', () => {
    activeAbortController?.abort();
    activeAbortController = null;
    setStreaming(false);
    sessionId = uuidv4();
    localStorage.setItem('mcp_session_id', sessionId);
    chatBox.innerHTML = `
        <div class="flex items-start space-x-3">
            <div class="ai-avatar">AI</div>
            <div class="bg-white p-4 rounded-2xl rounded-tl-none shadow-sm border border-slate-100 max-w-[85%]">
                <p class="text-slate-700">Chat reset. How can I help you?</p>
            </div>
        </div>`;
});

/*  Create message bubble ─ */
function createMessageUI(role) {
    const wrapper = document.createElement('div');
    wrapper.className = 'flex items-start space-x-3' + (role === 'user' ? ' flex-row-reverse space-x-reverse' : '');

    const avatar = document.createElement('div');
    avatar.className = role === 'user' ? 'user-avatar' : 'ai-avatar';
    avatar.innerText = role === 'user' ? 'U' : 'AI';

    const bubble = document.createElement('div');
    bubble.className = `p-4 rounded-2xl shadow-sm border max-w-[85%] ${role === 'user'
        ? 'bg-blue-600 text-white rounded-tr-none border-blue-500'
        : 'bg-white text-slate-700 rounded-tl-none border-slate-100'
        }`;

    // Agent-only elements
    let thinkingPanel = null, thinkingBody = null, thinkingSpinner = null, thinkingLabel = null;
    if (role === 'agent') {
        thinkingPanel = document.createElement('div');
        thinkingPanel.className = 'thinking-panel';

        const header = document.createElement('div');
        header.className = 'thinking-header';

        thinkingSpinner = document.createElement('div');
        thinkingSpinner.className = 'thinking-spinner spinning';

        thinkingLabel = document.createElement('span');
        thinkingLabel.textContent = 'Thinking…';

        const chevron = document.createElement('span');
        chevron.className = 'thinking-chevron';
        chevron.innerHTML = '&#9660;';

        header.appendChild(thinkingSpinner);
        header.appendChild(thinkingLabel);
        header.appendChild(chevron);

        thinkingBody = document.createElement('div');
        thinkingBody.className = 'thinking-body';

        // Click header to manually toggle
        header.addEventListener('click', () => toggleThinkingPanel(thinkingPanel, thinkingBody));

        thinkingPanel.appendChild(header);
        thinkingPanel.appendChild(thinkingBody);
        bubble.appendChild(thinkingPanel);

        // Open it immediately with GSAP
        openThinkingPanel(thinkingPanel, thinkingBody);
    }

    const contentDiv = document.createElement('div');
    contentDiv.className = 'markdown-content';
    contentDiv.dataset.fullText = '';

    bubble.appendChild(contentDiv);
    wrapper.appendChild(avatar);
    wrapper.appendChild(bubble);
    chatBox.appendChild(wrapper);

    // Animate message entry
    gsap.from(wrapper, { y: 16, opacity: 0, duration: 0.35, ease: 'power2.out' });
    chatBox.scrollTop = chatBox.scrollHeight;

    return { contentDiv, thinkingPanel, thinkingBody, thinkingSpinner, thinkingLabel };
}

/*  Thinking panel helpers  */
function openThinkingPanel(panel, body) {
    panel.classList.add('open');
    gsap.fromTo(body,
        { height: 0 },
        { height: 'auto', duration: 0.35, ease: 'power2.out' }
    );
}

function closeThinkingPanel(panel, body, spinner, label) {
    // Swap spinner → checkmark, update label
    spinner.classList.remove('spinning');
    spinner.style.borderColor = '#22c55e';
    spinner.style.borderTopColor = '#22c55e';
    if (label) label.textContent = 'Thought process';

    // Collapse body
    gsap.to(body, {
        height: 0,
        duration: 0.4,
        ease: 'power2.inOut',
        onComplete: () => panel.classList.remove('open'),
    });
}

function toggleThinkingPanel(panel, body) {
    const isOpen = panel.classList.contains('open');
    if (isOpen) {
        gsap.to(body, {
            height: 0, duration: 0.3, ease: 'power2.inOut',
            onComplete: () => panel.classList.remove('open')
        });
    } else {
        panel.classList.add('open');
        gsap.fromTo(body, { height: 0 }, { height: 'auto', duration: 0.3, ease: 'power2.out' });
    }
}

/*  Add a step row inside the thinking body ─ */
function addThinkingStep(thinkingBody, type, label, detail = null, args = null) {
    const step = document.createElement('div');
    step.className = 'thinking-step';

    const dot = document.createElement('div');
    dot.className = `step-dot ${type}`;

    const labelEl = document.createElement('span');
    labelEl.className = 'step-label';
    const icons = { status: '◆', tool: '⚡', success: '✓', error: '✕' };
    labelEl.textContent = (icons[type] || '·') + ' ' + label;

    step.appendChild(dot);
    step.appendChild(labelEl);

    if (detail) {
        const detailEl = document.createElement('span');
        detailEl.className = 'step-detail';
        detailEl.title = detail; // full text on hover
        detailEl.textContent = detail;
        step.appendChild(detailEl);
    }

    // Args / result expandable pill
    const expandableContent = args || detail;
    if ((type === 'tool' || type === 'success') && expandableContent) {
        const pill = document.createElement('button');
        pill.className = 'step-args-toggle';
        pill.textContent = type === 'tool' ? 'args' : 'result';

        const argsDiv = document.createElement('div');
        argsDiv.className = 'step-args';
        argsDiv.textContent = typeof expandableContent === 'string'
            ? expandableContent
            : JSON.stringify(expandableContent, null, 2);

        pill.addEventListener('click', (e) => {
            e.stopPropagation();
            step.classList.toggle('args-open');
            // Re-measure body height after toggle
            gsap.to(thinkingBody, { height: 'auto', duration: 0.2 });
        });

        step.appendChild(pill);
        step.appendChild(argsDiv);
    }

    thinkingBody.appendChild(step);

    // Animate row in
    gsap.to(step, { opacity: 1, y: 0, duration: 0.25, ease: 'power2.out' });

    // Keep body measured at 'auto' so new rows push it open
    gsap.to(thinkingBody, { height: 'auto', duration: 0.2, ease: 'power2.out' });
    smartScroll();
}

/*  Send  */
async function sendMessage() {
    const query = userInput.value.trim();
    if (!query) return;

    const db = dbSelector.value;
    userInput.value = '';

    const { contentDiv: userDiv } = createMessageUI('user');
    userDiv.innerText = query;

    const {
        contentDiv,
        thinkingPanel,
        thinkingBody,
        thinkingSpinner,
        thinkingLabel,
    } = createMessageUI('agent');

    setStreaming(true);
    activeAbortController = new AbortController();

    let sseBuffer = '';
    let contentStarted = false;
    let panelClosed = false;

    try {
        const response = await fetch('/search-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, session_id: sessionId, query_from: db }),
            signal: activeAbortController.signal,
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            sseBuffer += decoder.decode(value, { stream: true });

            const frames = sseBuffer.split('\n\n');
            sseBuffer = frames.pop();

            for (const frame of frames) {
                for (const line of frame.split('\n')) {
                    if (!line.startsWith('data: ')) continue;
                    const payload = line.slice(6).trim();
                    if (payload === '[DONE]') break;

                    try {
                        const event = JSON.parse(payload);
                        handleEvent(event, {
                            contentDiv,
                            thinkingPanel,
                            thinkingBody,
                            thinkingSpinner,
                            thinkingLabel,
                            contentStarted,
                            panelClosed,
                            onContentStart: () => {
                                if (!panelClosed) {
                                    panelClosed = true;
                                    closeThinkingPanel(thinkingPanel, thinkingBody, thinkingSpinner, thinkingLabel);
                                }
                                contentStarted = true;
                            },
                        });
                    } catch (e) {
                        console.warn('SSE parse error:', payload, e);
                    }
                }
            }
        }

    } catch (err) {
        if (err.name === 'AbortError') {
            addThinkingStep(thinkingBody, 'error', 'Stopped by user');
            if (!panelClosed) closeThinkingPanel(thinkingPanel, thinkingBody, thinkingSpinner, thinkingLabel);
        } else {
            console.error('Stream error:', err);
            contentDiv.innerHTML = '<span class="text-red-500">Connection error — check the server.</span>';
        }
    } finally {
        setStreaming(false);
        activeAbortController = null;
        if (!panelClosed) closeThinkingPanel(thinkingPanel, thinkingBody, thinkingSpinner, thinkingLabel);
        contentDiv.querySelectorAll('pre code:not([data-highlighted])').forEach(b => {
            hljs.highlightElement(b);
            b.dataset.highlighted = 'true';
        });
    }
}

/*  Event handler */
function handleEvent(event, ctx) {
    const { contentDiv, thinkingBody, onContentStart } = ctx;

    switch (event.type) {

        case 'status':
            addThinkingStep(thinkingBody, 'status', event.data);
            break;

        case 'thinking':
            // Model's internal <think> block — show as a special status row
            addThinkingStep(thinkingBody, 'status', 'Reasoning…', event.data.slice(0, 80));
            break;

        case 'tool_start':
            addThinkingStep(
                thinkingBody,
                'tool',
                `${event.name}`,
                describeArgs(event.args),
                event.args,
            );
            break;

        case 'tool_end':
            addThinkingStep(
                thinkingBody,
                'success',
                `${event.name} done`,
                event.result?.slice?.(0, 60) || '',
                event.result,
            );
            break;

        case 'error':
            addThinkingStep(thinkingBody, 'error', event.data);
            break;

        case 'content':
            // First content chunk → close the thinking panel
            onContentStart();
            updateContent(contentDiv, event.data);
            break;
    }
}

/*  Smart Auto-Scroll */
function smartScroll() {
    // Check if the user is within 150px of the bottom
    const isNearBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 150;

    // Only auto-scroll if they are already at the bottom
    if (isNearBottom) {
        chatBox.scrollTop = chatBox.scrollHeight;
    }
}

/*  Render streaming markdown */
function updateContent(container, chunk) {
    // 1. Check scroll position BEFORE adding new text
    const isNearBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 150;

    container.dataset.fullText += chunk;
    container.innerHTML = marked.parse(container.dataset.fullText);
    container.querySelectorAll('pre code:not([data-highlighted])').forEach(b => {
        hljs.highlightElement(b);
        b.dataset.highlighted = 'true';
    });

    // 2. Only scroll if they were near the bottom
    if (isNearBottom) {
        chatBox.scrollTop = chatBox.scrollHeight;
    }
}

/*  Summarise tool args into a short readable string  */
function describeArgs(args) {
    if (!args || typeof args !== 'object') return '';
    const q = args.query || args.input?.query || args.cypher || '';
    const src = args.query_from || '';
    const src_tag = src ? ` [${src}]` : '';

    if (q) return `query: "${q.slice(0, 45)}${q.length > 45 ? '…' : ''}"${src_tag}`;
    const keys = Object.keys(args).filter(k => k !== 'query_from');
    if (!keys.length) return src_tag;
    return keys.slice(0, 2).map(k => `${k}: ${String(args[k]).slice(0, 30)}`).join(' · ') + src_tag;
}

/*  Keyboard / click bindings */
sendBtn.addEventListener('click', sendMessage);
userInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});