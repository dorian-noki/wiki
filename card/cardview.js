let allCards = [];
let filteredCards = [];
let currentFilter = 'all';
let viewMode = 'simple';
let deckMode = false;
let currentDeckTab = 'main';

let deck = {
    main: {},
    ex: {}
};

function getCardImageData(card) {
    const fileName = String(card.cardName || '')
        .replace(/[\/\\:*?"<>|]/g, '')
        .trim();
    const fallbackByType = {
        monster: 'img/monster.png',
        ex: 'img/ex.png',
        magic: 'img/magic.png',
        supporter: 'img/supporter.png'
    };
    return {
        src: `cardimg/${encodeURIComponent(fileName)}.png`,
        fallback: fallbackByType[card.cardBase] || 'img/monster.png'
    };
}

function renderCardImage(card, className = 'card-art', frameClass = 'card-art-frame') {
    const image = getCardImageData(card);
    const alt = String(card.cardName || 'カード').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
    return `<div class="${frameClass}"><img class="${className}" src="${image.src}" data-fallback="${image.fallback}" alt="${alt}" onerror="this.onerror=null;this.src=this.dataset.fallback;"></div>`;
}

const fileInput = document.getElementById('fileInput');
const uploadArea = document.querySelector('.upload-area');

fileInput.addEventListener('change', handleFileSelect);
uploadArea.addEventListener('click', () => fileInput.click());

uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
});

uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/json') {
        loadJSON(file);
    }
});

function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file) loadJSON(file);
}

function loadJSON(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            setCardsFromData(data);
        } catch (error) {
            alert('JSONの読み込みに失敗しました: ' + error.message);
        }
    };
    reader.readAsText(file);
}

function setCardsFromData(data) {
    allCards = Array.isArray(data) ? data : [data];
    filteredCards = [...allCards];
    document.getElementById('uploadSection').classList.add('hidden');
    document.getElementById('contentSection').classList.remove('hidden');
    updateStats();
    renderCards();
    loadDeckFromCookie();
}

function autoLoadLocalJson() {
    const paths = ['card.json', './card.json'];
    let tried = 0;

    const tryFetch = () => {
        if (tried >= paths.length) {
            console.warn('card.json の自動読み込みに失敗しました。手動でアップロードしてください。');
            return;
        }

        const path = paths[tried++];
        fetch(path, { cache: 'no-cache' })
            .then(resp => {
                if (!resp.ok) throw new Error(`${path} not found (${resp.status})`);
                return resp.json();
            })
            .then(json => {
                setCardsFromData(json);
            })
            .catch((error) => {
                console.warn(`card.json 自動読み込み: ${path} を読み込めませんでした。`, error);
                tryFetch();
            });
    };

    tryFetch();
}

// デッキモード切り替え
document.getElementById('deckModeToggle').addEventListener('click', () => {
    deckMode = !deckMode;
    document.getElementById('mainContainer').classList.toggle('deck-mode', deckMode);
    document.getElementById('deckModeToggle').classList.toggle('active', deckMode);
    renderCards();
    if (deckMode) {
        renderDeck();
    }
});

// デッキタブ切り替え
document.querySelectorAll('.deck-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.deck-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentDeckTab = tab.dataset.deck;
        renderDeck();
    });
});

// デッキにカード追加
function addToDeck(cardIndex) {
    const card = allCards[cardIndex];
    const deckType = getDeckTypeForCard(card);
    
    if (!deck[deckType][cardIndex]) {
        deck[deckType][cardIndex] = 0;
    }
    
    if (deck[deckType][cardIndex] < getDeckCardLimit(cardIndex)) {
        deck[deckType][cardIndex]++;
        renderDeck();
        updateDeckCount();
        saveDeckToCookie();
        renderCards();
    }
}

function getDeckCardLimit(cardIndex) {
    if (AmarisCollection.getState().gameMode !== 'trading') return 3;
    return Math.min(3, AmarisCollection.getOwned(allCards[cardIndex]?.cardName));
}

// デッキからカード削除
function removeFromDeck(cardIndex) {
    const card = allCards[cardIndex];
    const deckType = getDeckTypeForCard(card);
    
    if (deck[deckType][cardIndex] && deck[deckType][cardIndex] > 0) {
        deck[deckType][cardIndex]--;
        if (deck[deckType][cardIndex] === 0) {
            delete deck[deckType][cardIndex];
        }
        renderDeck();
        updateDeckCount();
        saveDeckToCookie();
        renderCards();
    }
}

// カードがどのデッキに入るか判定
function getDeckTypeForCard(card) {
    if (card.cardBase === 'ex' || card.monsterType === '進化') {
        return 'ex';
    }
    return 'main';
}

// デッキのカード枚数を取得
function getCardCountInDeck(cardIndex) {
    const card = allCards[cardIndex];
    const deckType = getDeckTypeForCard(card);
    return deck[deckType][cardIndex] || 0;
}

// デッキ表示を更新
function renderDeck() {
    const deckBody = document.getElementById('deckBody');
    const currentDeck = deck[currentDeckTab];
    const cardIndexes = Object.keys(currentDeck).filter(idx => currentDeck[idx] > 0);

    if (cardIndexes.length === 0) {
        deckBody.innerHTML = '<div class="deck-empty">デッキにカードを追加してください</div>';
        return;
    }

    deckBody.innerHTML = cardIndexes.map(idx => {
        const card = allCards[idx];
        const count = currentDeck[idx];
        
        return `<div class="deck-card-item">
            <div class="deck-card-info">
                <div class="deck-card-name">${card.cardName || '名前なし'}</div>
                <div class="deck-card-meta">
                    ${card.cardBase === 'monster' || card.cardBase === 'ex' ? 
                        `⚔️${card.attack} ❤️${card.hp}` : 
                        card.cardBase === 'magic' ? `💎${card.magicCost}` : 'サポーター'}
                </div>
            </div>
            <div class="deck-card-count">
                <button class="deck-btn" onclick="removeFromDeck(${idx})" ${count === 0 ? 'disabled' : ''}>−</button>
                <span class="deck-count-num">${count}</span>
                <button class="deck-btn" onclick="addToDeck(${idx})" ${count >= getDeckCardLimit(idx) ? 'disabled' : ''}>+</button>
            </div>
        </div>`;
    }).join('');
}

// デッキ枚数更新
function updateDeckCount() {
    const mainCount = Object.values(deck.main).reduce((sum, count) => sum + count, 0);
    const exCount = Object.values(deck.ex).reduce((sum, count) => sum + count, 0);
    
    document.getElementById('mainDeckCount').textContent = mainCount;
    document.getElementById('exDeckCount').textContent = exCount;
    
    const deckCountEl = document.getElementById('deckCount');
    const ownershipIssues = AmarisCollection.getState().gameMode === 'trading'
        ? ['main', 'ex'].flatMap(zone => Object.entries(deck[zone])
            .filter(([index, count]) => Number(count) > getDeckCardLimit(Number(index)))
            .map(([index]) => allCards[Number(index)]?.cardName || '不明なカード'))
        : [];
    const isValid = mainCount >= 40 && mainCount <= 60 && exCount <= 15 && ownershipIssues.length === 0;
    document.getElementById('deckOwnershipStatus').textContent = ownershipIssues.length
        ? `所持数超過: ${[...new Set(ownershipIssues)].join('、')}`
        : '';
    
    if (isValid) {
        deckCountEl.classList.remove('error');
    } else {
        deckCountEl.classList.add('error');
    }
    
    document.getElementById('saveDeckBtn').disabled = !isValid;
}

// Cookie保存
function saveDeckToCookie() {
    document.cookie = `deck=${encodeURIComponent(JSON.stringify(deck))}; max-age=31536000; path=/; SameSite=Lax`;
    const toBattleDeck = deckType => Object.entries(deck[deckType]).map(([index, count]) => ({
        cardName: allCards[Number(index)]?.cardName,
        count
    })).filter(item => item.cardName && item.count > 0);
    localStorage.setItem('battleDeck', JSON.stringify({
        deckName: 'cardview-deck',
        main: toBattleDeck('main'),
        ex: toBattleDeck('ex')
    }));
}

// Cookie読み込み
function loadDeckFromCookie() {
    const cookies = document.cookie.split(';');
    for (let cookie of cookies) {
        const [name, value] = cookie.trim().split('=');
        if (name === 'deck') {
            try {
                deck = JSON.parse(decodeURIComponent(value));
                saveDeckToCookie();
                updateDeckCount();
                if (deckMode) {
                    renderDeck();
                }
            } catch (e) {
                console.error('デッキ読み込みエラー:', e);
            }
            break;
        }
    }

    if (!cookies.some(cookie => cookie.trim().startsWith('deck='))) {
        try {
            const savedDeck = JSON.parse(localStorage.getItem('battleDeck') || 'null');
            if (savedDeck && (Array.isArray(savedDeck.main) || Array.isArray(savedDeck.ex))) {
                deck = { main: {}, ex: {} };
                ['main', 'ex'].forEach(deckType => (savedDeck[deckType] || []).forEach(item => {
                    const cardIndex = allCards.findIndex(card => card.cardName === item.cardName);
                    if (cardIndex !== -1) deck[deckType][cardIndex] = Math.min(3, Number(item.count || 0));
                }));
                updateDeckCount();
                saveDeckToCookie();
                if (deckMode) renderDeck();
            }
        } catch (error) {
            console.error('対戦デッキ読み込みエラー:', error);
        }
    }
}

// デッキ保存
document.getElementById('saveDeckBtn').addEventListener('click', () => {
    saveDeckToCookie();
    alert('デッキを保存しました！');
});

// JSON エクスポート
document.getElementById('exportDeckBtn').addEventListener('click', () => {
    const exportData = {
        main: Object.keys(deck.main).map(idx => ({
            cardName: allCards[idx].cardName || '名前なし',
            count: deck.main[idx]
        })),
        ex: Object.keys(deck.ex).map(idx => ({
            cardName: allCards[idx].cardName || '名前なし',
            count: deck.ex[idx]
        }))
    };
    
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deck-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
});

document.getElementById('importDeckBtn').addEventListener('click', () => {
    document.getElementById('deckImportInput').click();
});

document.getElementById('deckImportInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const data = JSON.parse(event.target.result);
            if (data && (Array.isArray(data.main) || Array.isArray(data.ex))) {
                deck = { main: {}, ex: {} };
                const warnings = [];

                const fillDeck = (items, deckKey) => {
                    if (!Array.isArray(items)) return;
                    items.forEach(item => {
                        if (!item.cardName || !item.count) return;
                        const cardIndex = allCards.findIndex(card => card.cardName === item.cardName);
                        if (cardIndex === -1) {
                            warnings.push(`見つかりません: ${item.cardName}`);
                            return;
                        }
                        const card = allCards[cardIndex];
                        const targetKey = getDeckTypeForCard(card);
                        if (targetKey !== deckKey) {
                            warnings.push(`${item.cardName} は ${deckKey} ではなく ${targetKey} に分類されます`);
                        }
                        deck[targetKey][cardIndex] = Math.min(3, Number(item.count || 0));
                    });
                };

                fillDeck(data.main, 'main');
                fillDeck(data.ex, 'ex');

                updateDeckCount();
                renderDeck();
                saveDeckToCookie();
                renderCards();
                alert(`デッキを読み込みました。${warnings.length ? '\n' + warnings.join('\n') : ''}`);
            } else {
                alert('sample形式のデッキJSONを選択してください');
            }
        } catch (error) {
            alert('デッキJSON読み込みエラー: ' + error.message);
        }
    };
    reader.readAsText(file);
    e.target.value = '';
});

// 全消去
document.getElementById('clearDeckBtn').addEventListener('click', () => {
    if (confirm('デッキを全て消去しますか？')) {
        deck = { main: {}, ex: {} };
        renderDeck();
        updateDeckCount();
        saveDeckToCookie();
        renderCards();
    }
});

document.querySelectorAll('.filter-btn:not(#deckModeToggle)').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        applyFilters();
    });
});

document.getElementById('searchInput').addEventListener('input', applyFilters);
document.getElementById('sortSelect').addEventListener('change', applyFilters);
document.getElementById('searchName').addEventListener('change', applyFilters);
document.getElementById('searchType').addEventListener('change', applyFilters);
document.getElementById('searchContent').addEventListener('change', applyFilters);
document.getElementById('ownershipFilter').addEventListener('change', applyFilters);
document.getElementById('collectionModeSelect').value = AmarisCollection.getState().gameMode;
document.getElementById('collectionModeSelect').addEventListener('change', event => {
    AmarisCollection.setGameMode(event.target.value);
    updateDeckCount();
    renderDeck();
    renderCards();
});
document.getElementById('viewMode').addEventListener('change', (e) => {
    viewMode = e.target.value;
    renderCards();
});

function applyFilters() {
    const search = document.getElementById('searchInput').value.toLowerCase().trim();
    const sort = document.getElementById('sortSelect').value;
    const searchName = document.getElementById('searchName').checked;
    const searchType = document.getElementById('searchType').checked;
    const searchContent = document.getElementById('searchContent').checked;

    filteredCards = allCards.filter(card => {
        const matchFilter = currentFilter === 'all' || card.cardBase === currentFilter;
        const owned = AmarisCollection.getOwned(card.cardName) > 0;
        const ownershipFilter = document.getElementById('ownershipFilter').value;
        const matchOwnership = ownershipFilter === 'all' || (ownershipFilter === 'owned' ? owned : !owned);
        if (!search) return matchFilter && matchOwnership;

        let matchSearch = false;

        if (searchName) {
            const name = (card.cardName || '').toLowerCase();
            const ruby = (card.cardRuby || '').toLowerCase();
            if (name.includes(search) || ruby.includes(search)) {
                matchSearch = true;
            }
        }

        if (searchType && !matchSearch) {
            const tribe = (card.tribe || '').toLowerCase();
            const monsterType = (card.monsterType || '').toLowerCase();
            const monsterTypeText = (card.monsterTypeText || '').toLowerCase();
            if (tribe.includes(search) || monsterType.includes(search) || monsterTypeText.includes(search)) {
                matchSearch = true;
            }
        }

        if (searchContent && !matchSearch) {
            const supplementText = (card.supplementText || '').toLowerCase();
            const contentText = (card.contentText || '').toLowerCase();
            
            const skillTexts = (card.skills || []).map(s => 
                ((s.name || '') + ' ' + (s.text || '')).toLowerCase()
            ).join(' ');

            if (supplementText.includes(search) || contentText.includes(search) || skillTexts.includes(search)) {
                matchSearch = true;
            }
        }

        return matchFilter && matchOwnership && matchSearch;
    });

    filteredCards.sort((a, b) => {
        switch(sort) {
            case 'name': return a.cardName.localeCompare(b.cardName);
            case 'type': return a.cardBase.localeCompare(b.cardBase);
            case 'atk': return (b.attack || 0) - (a.attack || 0);
            case 'hp': return (b.hp || 0) - (a.hp || 0);
            default: return 0;
        }
    });

    document.getElementById('displayCards').textContent = filteredCards.length;
    renderCards();
}

function updateStats() {
    document.getElementById('totalCards').textContent = allCards.length;
    document.getElementById('displayCards').textContent = filteredCards.length;
    document.getElementById('monsterCount').textContent = allCards.filter(c => c.cardBase === 'monster' || c.cardBase === 'ex').length;
    document.getElementById('magicCount').textContent = allCards.filter(c => c.cardBase === 'magic').length;
    document.getElementById('supporterCount').textContent = allCards.filter(c => c.cardBase === 'supporter').length;
}

function renderCards() {
    const container = document.getElementById('cardContainer');

    if (viewMode === 'simple') {
        container.classList.add('simple-mode');
    } else {
        container.classList.remove('simple-mode');
    }

    if (filteredCards.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🔍</div>
                <h3>カードが見つかりません</h3>
                <p>フィルターを調整してください</p>
            </div>
        `;
        return;
    }

    container.innerHTML = filteredCards.map(card => {
        const cardIndex = allCards.indexOf(card);
        const cardCount = getCardCountInDeck(cardIndex);
        const ownedCount = AmarisCollection.getOwned(card.cardName);
        const typeClass = `type-${card.cardBase}`;
        const typeName = {
            monster: 'モンスター',
            magic: '魔法',
            supporter: 'サポーター',
            ex: 'EX'
        }[card.cardBase];

        const simpleClass = viewMode === 'simple' ? ' simple' : '';

        let html = `<div class="card-item${simpleClass}">
            <div class="card-header" onclick="showModal(${cardIndex})">
                <div class="card-title-section">
                    <div class="card-name">${card.cardName || '名前なし'}</div>
                    <div class="owned-count">所持 ${ownedCount}枚</div>
                    ${card.cardRuby && viewMode === 'detail' ? `<div class="card-ruby">${card.cardRuby}</div>` : ''}
                </div>
                <div class="card-meta">
                    <span class="card-type ${typeClass}">${typeName}</span>`;

        if (card.cardBase === 'monster' || card.cardBase === 'ex') {
            html += `<div class="card-stats">
                <span>⚔️${card.attack}</span>
                <span>❤️${card.hp}</span>
                ${card.tribe ? `<span>👥${card.tribe}</span>` : ''}
                ${card.monsterTypeText && viewMode === 'simple' ? `<span>🏷️${card.monsterTypeText}</span>` : ''}
            </div>`;
        } else if (card.cardBase === 'magic') {
            html += `<div class="card-stats"><span>💎${card.magicCost}</span></div>`;
        }

        html += `</div>`;

        if (deckMode) {
            html += `<div class="card-controls" onclick="event.stopPropagation()">
                <button class="deck-btn" onclick="removeFromDeck(${cardIndex})" ${cardCount === 0 ? 'disabled' : ''}>−</button>
                <span class="deck-count-num">${cardCount}</span>
                <button class="deck-btn" onclick="addToDeck(${cardIndex})" ${cardCount >= getDeckCardLimit(cardIndex) ? 'disabled' : ''}>+</button>
            </div>`;
        }

        html += `</div>`;

        if (viewMode === 'detail') {
            html += `<div class="card-body">${renderCardImage(card)}`;

            if (card.cardBase === 'monster' || card.cardBase === 'ex') {
                html += `<div class="card-info-row">`;
                
                if (card.monsterType) {
                    html += `<div class="card-section">
                        <div class="section-label">種別:</div>
                        <div class="section-content">${card.monsterType}モンスター</div>
                    </div>`;
                }

                if (card.tribe) {
                    html += `<div class="card-section">
                        <div class="section-label">族:</div>
                        <div class="section-content">${card.tribe}</div>
                    </div>`;
                }

                if (card.monsterTypeText) {
                    html += `<div class="card-section">
                        <div class="section-label">タイプ:</div>
                        <div class="section-content">${card.monsterTypeText}</div>
                    </div>`;
                }
                
                html += `</div>`;

                if (card.evolutionSource) {
                    html += `<div class="card-section full-width">
                        <div class="section-label">進化元</div>
                        <div class="section-content">${card.evolutionSource}</div>
                    </div>`;
                }

                if (card.supplementText) {
                    html += `<div class="card-section full-width">
                        <div class="section-label">補足</div>
                        <div class="section-content">${card.supplementText}</div>
                    </div>`;
                }

                if (card.skills && card.skills.length > 0) {
                    html += `<div class="card-section full-width">
                        <div class="section-label">スキル</div>
                        <div class="skill-list">`;
                    card.skills.forEach(skill => {
                        html += `<div class="skill-item">
                            <div class="skill-header">${skill.type}: ${skill.name}</div>
                            ${skill.text ? `<div class="skill-text">${skill.text}</div>` : ''}
                        </div>`;
                    });
                    html += `</div></div>`;
                }
            }

            if (card.contentText) {
                html += `<div class="card-section full-width">
                    <div class="section-label">効果</div>
                    <div class="section-content">${card.contentText}</div>
                </div>`;
            }

            html += `</div>`;
        }

        html += `</div>`;
        return html;
    }).join('');
}

function showModal(index) {
    const card = allCards[index];
    
    document.getElementById('modalName').textContent = card.cardName || '名前なし';
    document.getElementById('modalRuby').textContent = card.cardRuby || '';
    document.getElementById('modalRuby').style.display = card.cardRuby ? 'block' : 'none';
    
    const modalBody = document.getElementById('modalBody');
    let bodyHTML = renderCardImage(card, 'card-art modal-card-image', 'card-art-frame modal-card-art');

    const typeName = {
        monster: 'モンスター',
        magic: '魔法',
        supporter: 'サポーター',
        ex: 'EX'
    }[card.cardBase];

    bodyHTML += `<div class="modal-section">
        <div class="modal-section-label">カードタイプ</div>
        <div class="modal-section-content">${typeName}</div>
    </div>`;

    if (card.cardBase === 'monster' || card.cardBase === 'ex') {
        bodyHTML += `<div class="modal-section">
            <div class="modal-section-label">ステータス</div>
            <div class="modal-info-row">
                <div class="modal-info-item">
                    <span class="modal-section-label">ATK:</span>
                    <span class="modal-section-content">${card.attack}</span>
                </div>
                <div class="modal-info-item">
                    <span class="modal-section-label">HP:</span>
                    <span class="modal-section-content">${card.hp}</span>
                </div>
            </div>
        </div>`;

        if (card.monsterType || card.tribe || card.monsterTypeText) {
            bodyHTML += `<div class="modal-section">
                <div class="modal-section-label">分類</div>
                <div class="modal-info-row">`;
            
            if (card.monsterType) {
                bodyHTML += `<div class="modal-info-item">
                    <span class="modal-section-label">種別:</span>
                    <span class="modal-section-content">${card.monsterType}モンスター</span>
                </div>`;
            }
            if (card.tribe) {
                bodyHTML += `<div class="modal-info-item">
                    <span class="modal-section-label">族:</span>
                    <span class="modal-section-content">${card.tribe}</span>
                </div>`;
            }
            if (card.monsterTypeText) {
                bodyHTML += `<div class="modal-info-item">
                    <span class="modal-section-label">タイプ:</span>
                    <span class="modal-section-content">${card.monsterTypeText}</span>
                </div>`;
            }
            
            bodyHTML += `</div></div>`;
        }

        if (card.evolutionSource) {
            bodyHTML += `<div class="modal-section">
                <div class="modal-section-label">進化元</div>
                <div class="modal-section-content">${card.evolutionSource}</div>
            </div>`;
        }

        if (card.supplementText) {
            bodyHTML += `<div class="modal-section">
                <div class="modal-section-label">補足テキスト</div>
                <div class="modal-section-content">${card.supplementText}</div>
            </div>`;
        }

        if (card.skills && card.skills.length > 0) {
            bodyHTML += `<div class="modal-section">
                <div class="modal-section-label">スキル</div>
                <div class="modal-skills">`;
            card.skills.forEach(skill => {
                bodyHTML += `<div class="modal-skill-item">
                    <div class="modal-skill-name">${skill.type}: ${skill.name}</div>
                    ${skill.text ? `<div class="modal-skill-text">${skill.text}</div>` : ''}
                </div>`;
            });
            bodyHTML += `</div></div>`;
        }
    }

    if (card.cardBase === 'magic') {
        bodyHTML += `<div class="modal-section">
            <div class="modal-section-label">コスト</div>
            <div class="modal-section-content">💎 ${card.magicCost}</div>
        </div>`;
    }

    if (card.contentText) {
        bodyHTML += `<div class="modal-section">
            <div class="modal-section-label">効果</div>
            <div class="modal-section-content">${card.contentText}</div>
        </div>`;
    }

    modalBody.innerHTML = bodyHTML;
    document.getElementById('detailModal').classList.add('active');
}

function closeModal(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('detailModal').classList.remove('active');
}

window.addEventListener('DOMContentLoaded', autoLoadLocalJson);