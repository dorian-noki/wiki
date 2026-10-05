import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getDatabase, onDisconnect, onValue, ref, runTransaction, set } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js';

const firebaseConfig = {
    apiKey: 'AIzaSyDsAReuxuTmRT6mPi8HRZcxNYaJvBDCR0g',
    authDomain: 'cardgametest-8b285.firebaseapp.com',
    databaseURL: 'https://cardgametest-8b285-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'cardgametest-8b285',
    storageBucket: 'cardgametest-8b285.firebasestorage.app',
    messagingSenderId: '760889130742',
    appId: '1:760889130742:web:c71ab18fffcde76853f6d7'
};

const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);
const soloModeRequested = new URLSearchParams(window.location.search).get('mode') === 'solo';
let skillNameMode = localStorage.getItem('skillNameMode') === 'name' ? 'name' : 'number';

// ===== ゲーム状態管理(オンライン同期用の基盤) =====
const gameState = {
    players: [
        { id: '2P', hp: 5, shield: 3, mana: 10, maxMana: 10, deck: [], hand: [], field: { battle: [null, null, null], reserve: [null, null, null], counter: null }, graveyard: [], ex: [], mulliganReady: false },
        { id: '1P', hp: 5, shield: 3, mana: 10, maxMana: 10, deck: [], hand: [], field: { battle: [null, null, null], reserve: [null, null, null], counter: null }, graveyard: [], ex: [], free: [], mulliganReady: false }
    ],
    turn: 1,
    currentPlayer: 1,
    isFirstPlayerFirstTurn: true,
    logs: [{ type: 'system', message: '対戦を開始しました', time: Date.now() }],
    privateLogs: [], // 自分専用ログ
    selectedCard: null,
    selectedCardSource: null,
    handZoneMode: 'hand',
    opponentHandView: false,
    mulliganPhase: true,
    mulliganSelected: [],
    selectedFieldCell: null,
    selectedFieldPosition: null,
    usedSupporterThisTurn: false,
    selectedFieldMonster: null,
    winner: null,
    playMode: 'manual',
    operationMode: 'private',
    soloMode: soloModeRequested
};

// 日本語変換マップ
const translations = {
    cardBase: {
        'monster': 'モンスター',
        'ex': 'EXモンスター',
        'magic': '魔法',
        'supporter': 'サポーター'
    },
    attribute: {
        'ti': '地',
        'hi': '火',
        'mizu': '水',
        'kaze': '風',
        'yami': '闇',
        'hikari': '光'
    },
    monsterType: {
        '通常': '通常',
        '進化': '進化',
        '特殊進化': '特殊進化',
        'EX': 'EX'
    }
};

let cardDatabase = [];
let loadedDeckData = null;

async function initializeCardDatabase() {
    try {
        const response = await fetch('card.json', { cache: 'no-cache' });
        cardDatabase = await response.json();
    } catch (error) {
        console.error('カードデータの読み込みに失敗しました:', error);
        cardDatabase = [];
    }
}

function findCardData(reference) {
    if (!reference) return null;
    const key = typeof reference === 'string'
        ? reference
        : reference.cardId || reference.id || reference.cardName || (typeof reference.card === 'string' ? reference.card : null);

    if (!key) return null;
    return cardDatabase.find(card => card.cardName === key || card.cardId === key || card.id === key) || null;
}

function resolveDeckCard(item) {
    if (!item) return null;
    if (item.card && typeof item.card === 'object' && item.card.cardName) {
        return item.card;
    }
    if (item.card && typeof item.card === 'string') {
        return findCardData(item.card);
    }
    const key = item.cardName || item.cardId || item.id || (item.card && typeof item.card === 'string' ? item.card : null);
    return findCardData(key) || null;
}

function getCardEffectText(card) {
    if (!card) return '';
    const effects = [];
    if (card.contentText?.trim()) effects.push(card.contentText.trim());
    (card.skills || []).forEach(skill => {
        if (skill.text?.trim()) effects.push(`${getSkillDisplayName(card, skill)}: ${skill.text.trim()}`);
    });
    return effects.join(' / ') || '効果テキストなし';
}

function getSkillDisplayName(card, skill) {
    if (skillNameMode === 'name' && skill.name?.trim()) return skill.name;
    const skillsOfType = (card?.skills || []).filter(item => item.type === skill.type);
    const number = skillsOfType.indexOf(skill) + 1;
    return `${skill.type === 'A' ? 'A' : 'P'}スキル ${number}`;
}

function redactCardNames(message) {
    return cardDatabase
        .map(card => card.cardName)
        .sort((left, right) => right.length - left.length)
        .reduce((redacted, cardName) => redacted.replaceAll(cardName, 'カード'), String(message || ''));
}

function formatSkillNamesForDisplay(message) {
    if (skillNameMode === 'name') return String(message || '');
    return cardDatabase.reduce((formatted, card) => (card.skills || []).reduce((text, skill) => {
        if (!skill.name?.trim()) return text;
        return text.replaceAll(skill.name, getSkillDisplayName(card, skill));
    }, formatted), String(message || ''));
}

// 独立した場出しパネルの制御
let placementPanelCardIndex = null;
let placementPanelSource = 'hand';
let placementPanelView = 'self';
let selectedFieldPlayer = 1;

const networkState = {
    connected: false,
    roomId: null,
    playerId: null,
    playerNumber: null,
    roomRef: null,
    unsubscribe: null,
    receivingState: false,
    lastSentState: null,
    pendingState: null
};

const handledActionIds = new Set();

function generateActionId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function parsePlayerNumber(value) {
    if (!value) return null;
    const normalized = String(value).trim().toUpperCase();
    const match = normalized.match(/[12]/);
    if (!match) return null;
    return parseInt(match[0], 10);
}

function normalizePlayerId(value) {
    const num = parsePlayerNumber(value);
    return num ? `${num}P` : null;
}

function updateOnlineStatus(text) {
    const status = document.getElementById('onlineStatus');
    if (status) {
        status.textContent = text;
    }
}

function updateOnlinePlayers(players) {
    const list = document.getElementById('onlinePlayers');
    if (list) {
        list.textContent = players && players.length ? `プレイヤー: ${players.join(' / ')}` : 'プレイヤー: -';
    }
}

function isCurrentPlayerTurn() {
    return gameState.currentPlayer === 1;
}

function isSemiAutoMode() {
    return gameState.playMode === 'semi-auto';
}

function isPlayerTwoView() {
    return networkState.playerNumber === 2;
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.values(value);
    return [];
}

function normalizeSlots(value) {
    const slots = asArray(value).slice(0, 3);
    while (slots.length < 3) slots.push(null);
    return slots;
}

function normalizeRoomState(state) {
    const players = asArray(state.players).slice(0, 2);
    while (players.length < 2) players.push({});

    return {
        ...gameState,
        ...state,
        playMode: state.playMode === 'semi-auto' ? 'semi-auto' : 'manual',
        operationMode: ['private', 'public', 'auto'].includes(state.operationMode) ? state.operationMode : 'private',
        players: players.map((player, index) => {
            const field = player.field || {};
            return {
                id: player.id || (index === 0 ? '2P' : '1P'),
                hp: Number.isFinite(player.hp) ? player.hp : 5,
                shield: Number.isFinite(player.shield) ? player.shield : 3,
                mana: Number.isFinite(player.mana) ? player.mana : 0,
                maxMana: Number.isFinite(player.maxMana) ? player.maxMana : 0,
                deck: asArray(player.deck),
                hand: asArray(player.hand),
                graveyard: asArray(player.graveyard),
                ex: asArray(player.ex),
                free: asArray(player.free),
                mulliganReady: player.mulliganReady === true,
                field: {
                    ...gameState.players[index].field,
                    ...field,
                    battle: normalizeSlots(field.battle),
                    reserve: normalizeSlots(field.reserve),
                    counter: field.counter || null
                }
            };
        }),
        logs: asArray(state.logs),
        privateLogs: asArray(state.privateLogs),
        mulliganSelected: asArray(state.mulliganSelected),
        handZoneMode: ['hand', 'free', 'graveyard', 'deck', 'ex', 'opponent-graveyard-view', 'opponent-deck-view', 'opponent-ex-view'].includes(state.handZoneMode)
            ? state.handZoneMode
            : 'hand'
    };
}

function toLocalState(state) {
    const normalizedState = normalizeRoomState(state);
    if (!isPlayerTwoView()) return normalizedState;
    return { ...normalizedState, players: [normalizedState.players[1], normalizedState.players[0]], currentPlayer: normalizedState.currentPlayer === 1 ? 0 : 1 };
}

function toSharedState(state) {
    if (!isPlayerTwoView()) return state;
    return { ...state, players: [state.players[1], state.players[0]], currentPlayer: state.currentPlayer === 1 ? 0 : 1 };
}

function createSharedState() {
    const state = toSharedState(gameState);
    return {
        ...state,
        selectedCard: null,
        selectedCardSource: null,
        selectedFieldCell: null,
        selectedFieldPosition: null,
        selectedFieldMonster: null,
        handZoneMode: 'hand',
        opponentHandView: false,
        mulliganSelected: [],
        logs: gameState.operationMode === 'public'
            ? state.logs
            : state.logs.map(log => gameState.operationMode === 'auto' && log.revealCardNames
                ? log
                : ({ ...log, message: redactCardNames(log.message) })),
        privateLogs: gameState.operationMode === 'public' ? state.privateLogs : []
    };
}

async function connectOnline(roomId, playerId) {
    const normalizedRoomId = roomId.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    const playerNumber = parsePlayerNumber(playerId);

    if (!normalizedRoomId || !playerNumber) {
        updateOnlineStatus('部屋名とプレイヤー番号を確認してください');
        return;
    }

    if (networkState.unsubscribe) networkState.unsubscribe();

    networkState.roomId = normalizedRoomId;
    networkState.playerId = normalizePlayerId(playerId);
    networkState.playerNumber = playerNumber;
    document.getElementById('onlineRoomInput').value = normalizedRoomId;
    document.getElementById('onlinePlayerInput').value = String(playerNumber);
    networkState.roomRef = ref(database, `cardRooms/${normalizedRoomId}`);
    networkState.connected = false;
    networkState.lastSentState = null;
    updateOnlineStatus('接続中...');

    try {
        await runTransaction(networkState.roomRef, current => current || { state: createSharedState(), players: {} });
        networkState.unsubscribe = onValue(networkState.roomRef, snapshot => {
            const room = snapshot.val();
            if (!room?.state) return;
            const localPlayer = gameState.players[1];
            const hasLocalDeck = localPlayer.deck.length > 0 || localPlayer.hand.length > 0 || localPlayer.ex.length > 0;
            networkState.receivingState = true;
            Object.assign(gameState, toLocalState(room.state));
            if (hasLocalDeck) {
                gameState.players[1].deck = localPlayer.deck;
                gameState.players[1].hand = localPlayer.hand;
                gameState.players[1].ex = localPlayer.ex;
                gameState.players[1].free = localPlayer.free || [];
            }
            updateOnlinePlayers(Object.keys(room.players || {}).sort());
            renderUI();
            updateGameStartButton();
            networkState.receivingState = false;

            const localSharedState = createSharedState();
            const remoteSharedState = normalizeRoomState(room.state);
            if (hasLocalDeck && JSON.stringify(localSharedState) !== JSON.stringify(remoteSharedState)) {
                sendGameState();
            } else {
                networkState.lastSentState = JSON.stringify(localSharedState);
            }
        }, error => {
            console.error('Firebase同期エラー:', error);
            networkState.connected = false;
            updateOnlineStatus('接続エラー');
        });
        networkState.connected = true;
        const playerRef = ref(database, `cardRooms/${normalizedRoomId}/players/${networkState.playerId}`);
        await set(playerRef, true);
        await onDisconnect(playerRef).remove();
        updateOnlineStatus(`接続済み (${networkState.playerId})`);
        sendGameState();
    } catch (error) {
        console.error('Firebase接続エラー:', error);
        updateOnlineStatus('接続エラー');
    }
}

function receiveOnlineMessage() {
    // FirebaseのonValueで状態を受け取るため、この関数は互換用です。
}

function sendOnlineMessage() {
    // Firebaseの同期では個別メッセージを使用しません。
}

function sendGameState() {
    if (!networkState.connected || !networkState.roomRef || networkState.receivingState) return;
    const state = createSharedState();
    const serializedState = JSON.stringify(state);
    if (serializedState === networkState.lastSentState || serializedState === networkState.pendingState) return;

    networkState.pendingState = serializedState;
    set(ref(database, `cardRooms/${networkState.roomId}/state`), state).then(() => {
        networkState.lastSentState = serializedState;
    }).catch(error => {
        console.error('Firebase状態保存エラー:', error);
        updateOnlineStatus('同期エラー');
    }).finally(() => {
        if (networkState.pendingState === serializedState) networkState.pendingState = null;
    });
}

function updateGameStartButton() {
    const button = document.getElementById('startGameBtn');
    const status = document.getElementById('gameStartStatus');
    if (!button || !status) return;

    const player = gameState.players[1];
    const hasCards = player.deck.length > 0 || player.hand.length > 0;
    const needsInitialDraw = player.hand.length === 0 && player.deck.length > 0;
    const ownershipIssues = AmarisCollection.getState().gameMode === 'trading' && loadedDeckData
        ? AmarisCollection.getDeckOwnershipIssues(loadedDeckData)
        : [];
    button.disabled = !hasCards || !gameState.mulliganPhase || player.mulliganReady || ownershipIssues.length > 0;
    button.textContent = ownershipIssues.length
        ? '所持カードを確認してください'
        : !gameState.mulliganPhase
        ? gameState.soloMode ? 'ソロプレイ中' : 'ゲーム進行中'
        : player.mulliganReady
            ? '相手の準備待ち'
            : needsInitialDraw
                ? '初手を引く'
                : '初手を確定';
    status.textContent = ownershipIssues.length
        ? `所持数超過: ${ownershipIssues.map(issue => `${issue.cardName} ${issue.count}/${issue.limit}`).join('、')}`
        : !hasCards
        ? 'デッキを読み込んでください'
        : !gameState.mulliganPhase
            ? gameState.soloMode ? `ソロ・ターン${gameState.turn}` : `ターン${gameState.turn}・${isCurrentPlayerTurn() ? 'あなたのターン' : '相手のターン'}`
        : player.mulliganReady
            ? '相手が初手を確定すると対戦が始まります'
        : gameState.mulliganPhase && needsInitialDraw
            ? '初手カードがありません。先に初手を引いてください'
            : `初手 ${player.hand.length}枚を確認して確定してください`;
}

function isAdjacentFieldPosition(currentPos, targetPos) {
    if (!currentPos || !targetPos) return false;
    const rowA = currentPos.zone === 'battle' ? 0 : 1;
    const rowB = targetPos.zone === 'battle' ? 0 : 1;
    const colA = currentPos.index;
    const colB = targetPos.index;
    const rowDiff = Math.abs(rowA - rowB);
    const colDiff = Math.abs(colA - colB);
    return (rowDiff <= 1 && colDiff <= 1) && !(rowDiff === 0 && colDiff === 0);
}

function updatePlacementPanelView() {
    const isSelfView = placementPanelView === 'self';
    const toggleBtn = document.getElementById('placementViewToggleBtn');
    toggleBtn.textContent = isSelfView ? '相手ゾーンを表示' : '自分ゾーンを表示';

    document.querySelectorAll('.placement-cell').forEach(cell => {
        const player = cell.dataset.player;
        const zone = cell.dataset.zone;
        const index = parseInt(cell.dataset.index, 10);
        const ownerLabel = player === '1' ? '自分' : '相手';
        const visible = isSelfView ? player === '1' : player === '0';

        cell.classList.toggle('hidden', !visible);
        if (!visible) return;

        if (zone === 'battle') {
            cell.textContent = `${ownerLabel}バトル${index + 1}`;
        } else if (zone === 'reserve') {
            cell.textContent = `${ownerLabel}控え${index + 1}`;
        }
    });
}

// 独立パネルを表示
function showPlacementPanel(cardIndex, card, isMoveMode = false, source = 'hand') {
    placementPanelCardIndex = cardIndex;
    placementPanelSource = source;
    placementPanelView = 'self';
    const panel = document.getElementById('placementPanel');
    const confirmBtn = document.getElementById('placementConfirmBtn');
    const title = document.querySelector('.placement-title');
    const previewImage = document.getElementById('placementPreviewImage');
    const previewName = document.getElementById('placementPreviewName');
    
    if (isMoveMode) {
        title.firstElementChild.textContent = '移動先を選択';
    } else if (card.monsterType === '進化') {
        title.firstElementChild.textContent = '進化先を選択';
    } else {
        title.firstElementChild.textContent = '場に出す位置を選択';
    }
    
    panel.classList.add('active');
    confirmBtn.disabled = true;

    const viewToggleBtn = document.getElementById('placementViewToggleBtn');
    viewToggleBtn.style.display = isMoveMode ? 'none' : '';

    updatePlacementPanelView();

    const imgData = getCardImagePath({ card });
    previewImage.src = imgData.primary;
    previewImage.onerror = () => {
        previewImage.src = imgData.fallback;
    };
    previewName.textContent = card.cardName || 'カード';
    
    document.querySelectorAll('.placement-cell').forEach(cell => {
        const zone = cell.dataset.zone;
        const playerIndex = parseInt(cell.dataset.player, 10);
        const index = parseInt(cell.dataset.index, 10);
        const fieldZone = gameState.players[playerIndex].field[zone];
        const monster = fieldZone ? fieldZone[index] : null;
        
        cell.classList.remove('selected', 'disabled', 'hidden');
        
        if (isMoveMode) {
            const currentPos = gameState.selectedFieldPosition;
            const targetPos = { zone, index };

            if (playerIndex !== 1 || !isAdjacentFieldPosition(currentPos, targetPos)) {
                cell.classList.add('disabled');
            }
        } else {
            if (card.monsterType === '通常') {
                if (monster !== null) {
                    cell.classList.add('disabled');
                }
            } else if (card.monsterType === '特殊進化') {
                if (monster === null) {
                    cell.classList.add('disabled');
                }
            } else if (card.monsterType === '進化') {
                const evolutionSources = findEvolutionSourcePositions(1, card);
                const replacesSource = evolutionSources?.some(position => position.zone === zone && position.index === index);
                if (playerIndex !== 1 || (monster !== null && !replacesSource) || !evolutionSources) cell.classList.add('disabled');
            } else {
                cell.classList.add('disabled');
            }
        }
    });
    updatePlacementPanelView();
}

function hidePlacementPanel() {
    document.getElementById('placementPanel').classList.remove('active');
    document.querySelectorAll('.placement-cell').forEach(cell => {
        cell.classList.remove('selected');
    });
    placementPanelCardIndex = null;
}

function parseEvolutionRequirements(evolutionSource) {
    const text = String(evolutionSource || '');
    if (!text) return [];
    const requirements = [];
    const quotedNames = [...text.matchAll(/[「『]([^」』]+)[」』]/g)].map(match => match[1]);
    quotedNames.forEach(name => requirements.push({ name: normalizeCardName(name), count: 1 }));
    const tribes = [...text.matchAll(/([^+\s「」]+族)モンスター(?:を)?(\d+)体?/g)];
    tribes.forEach(match => requirements.push({ tribe: match[1], count: Number(match[2]) }));
    if (!tribes.length) {
        const tribeOnly = text.match(/([^+\s「」]+族)モンスター/);
        if (tribeOnly) requirements.push({ tribe: tribeOnly[1], count: 1 });
    }
    return requirements;
}

function findEvolutionSourcePositions(playerIndex, evolutionCard) {
    const requirements = parseEvolutionRequirements(evolutionCard?.evolutionSource);
    if (!requirements.length) {
        return normalizeCardName(evolutionCard?.cardName) === normalizeCardName('ギガントライナー') ? [] : null;
    }
    const available = ['battle', 'reserve'].flatMap(zone => gameState.players[playerIndex].field[zone]
        .map((monster, index) => monster ? { zone, index, monster } : null).filter(Boolean));
    const used = new Set();
    const selected = [];
    for (const requirement of requirements) {
        const matches = available.filter(position => {
            const key = `${position.zone}:${position.index}`;
            if (used.has(key)) return false;
            if (requirement.name && normalizeCardName(position.monster.card.cardName) !== requirement.name) return false;
            if (requirement.tribe && position.monster.card.tribe !== requirement.tribe) return false;
            return true;
        }).slice(0, requirement.count);
        if (matches.length !== requirement.count) return null;
        matches.forEach(position => {
            used.add(`${position.zone}:${position.index}`);
            selected.push(position);
        });
    }
    return selected;
}

// 対象選択モーダルを表示
function showTargetSelection(title, callback, options = {}) {
    const modal = document.getElementById('targetModal');
    const modalTitle = document.getElementById('targetModalTitle');
    const targetGrid = document.getElementById('targetGrid');
    const confirmBtn = document.getElementById('targetConfirmBtn');
    const allowReserve = options.allowReserve !== false;
    const allowDirect = options.allowDirect !== false;
    const playerIndexes = options.playerIndexes || [0];
    const hpLimit = Number(options.effectText?.match(/HPが(\d+)以下/)?.[1]);
    
    modalTitle.textContent = title;
    targetGrid.innerHTML = '';
    
    let selectedTarget = null;
    
    playerIndexes.forEach(playerIndex => {
        ['battle', 'reserve'].forEach(zone => {
            if (zone === 'reserve' && !allowReserve) return;
            gameState.players[playerIndex].field[zone].forEach((monster, index) => {
                const cell = document.createElement('div');
                cell.className = 'target-cell';
                cell.textContent = `${gameState.players[playerIndex].id} ${zone === 'battle' ? 'バトル' : '控え'}${index + 1}`;
                const remainingHp = monster ? getMonsterMaxHp(monster) - (monster.currentDamage || 0) : 0;
                if (!monster || (hpLimit && remainingHp > hpLimit)) cell.classList.add('disabled');
                cell.addEventListener('click', () => {
                    if (cell.classList.contains('disabled')) return;
                    document.querySelectorAll('.target-cell').forEach(targetCell => targetCell.classList.remove('selected'));
                    cell.classList.add('selected');
                    selectedTarget = { playerIndex, zone, index };
                    confirmBtn.disabled = false;
                });
                targetGrid.appendChild(cell);
            });
        });
    });
    
    const directCell = document.createElement('div');
    directCell.className = 'target-cell';
    directCell.textContent = '直接攻撃';
    directCell.style.gridColumn = 'span 3';
    if (!allowDirect) directCell.classList.add('disabled');
    directCell.addEventListener('click', () => {
        if (directCell.classList.contains('disabled')) return;
        document.querySelectorAll('.target-cell').forEach(c => c.classList.remove('selected'));
        directCell.classList.add('selected');
        selectedTarget = { playerIndex: 0, direct: true };
        confirmBtn.disabled = false;
    });
    targetGrid.appendChild(directCell);
    
    confirmBtn.disabled = true;
    confirmBtn.onclick = () => {
        if (selectedTarget) {
            callback(selectedTarget);
            modal.classList.remove('active');
        }
    };
    
    modal.classList.add('active');
}

// 翻訳関数
function translate(key, value) {
    return translations[key]?.[value] || value;
}

function hasMonstersOnField(playerIndex) {
    const field = gameState.players[playerIndex].field;
    return [...field.battle, ...field.reserve].some(monster => monster !== null);
}

function canDirectAttackWithMonster(monster) {
    return (monster?.card?.skills || []).some(skill => skill.type === 'P' && /このカードは直接攻撃できる/.test(skill.text || ''));
}

function drawCardForPlayer(playerIndex, record = true) {
    const player = gameState.players[playerIndex];
    if (player.deck.length === 0) return null;

    const drawnCard = player.deck.shift();
    player.hand.push(drawnCard);
    if (record) {
        gameState.logs.push({
            type: 'system',
            message: gameState.operationMode === 'public'
                ? `${player.id}が「${drawnCard.card.cardName}」をドローしました`
                : `${player.id}がカードを1枚ドローしました`,
            time: Date.now()
        });
        if (gameState.operationMode !== 'public' && playerIndex === 1) {
            gameState.privateLogs.push({ type: 'private', message: `カードを1枚ドローしました: ${drawnCard.card.cardName}`, time: Date.now() });
        }
    }
    return drawnCard;
}

function drawCardsForEffect(playerIndex, amount) {
    const player = gameState.players[playerIndex];
    let drawn = 0;
    for (let drawIndex = 0; drawIndex < amount; drawIndex++) {
        const card = drawCardForPlayer(playerIndex);
        if (!card) {
            gameState.winner = gameState.players[1 - playerIndex].id;
            gameState.logs.push({ type: 'system', message: `${player.id}がライブラリアウトで敗北しました。${gameState.winner}の勝利です`, time: Date.now() });
            break;
        }
        drawn++;
    }
    return drawn;
}

function resolveAutomaticEffectText(effectText, playerIndex, context = {}) {
    let unresolved = String(effectText || '').trim();
    if (!unresolved || unresolved === '-') return { handled: false, unresolved: '' };
    let handled = false;
    const player = gameState.players[playerIndex];
    const opponentIndex = 1 - playerIndex;

    if (context.cardChoice) {
        if (moveSelectedEffectCard(playerIndex, context.cardChoice)) {
            const resolvedSearch = unresolved.match(/[^。．]*(?:墓地|墓場|デッキ|山札|EX)から[^。．]*(?:手札に加える|場に出す|場に召喚|墓地へ送る|墓地に送る|EXデッキに戻す)[^。．]*[。．]?/);
            if (resolvedSearch) unresolved = unresolved.replace(resolvedSearch[0], '');
            handled = true;
        } else {
            gameState.logs.push({ type: 'system', message: '選択カードを移動できません。空きゾーンとカード種類を確認してください', time: Date.now() });
        }
    }

    const simpleDraw = parseSimpleDrawEffect({ contentText: unresolved });
    if (simpleDraw !== null) {
        const drawn = drawCardsForEffect(playerIndex, simpleDraw);
        unresolved = '';
        handled = true;
        gameState.logs.push({ type: 'system', message: `自動: ${drawn}枚ドローしました`, time: Date.now() });
    } else {
        const shieldBasedDraw = unresolved.match(/5\s*[-−]\s*シールドの数だけドロー(?:する)?/);
        const opponentCountDraw = unresolved.match(/相手の場のモンスターの数だけドロー(?:する)?/);
        const fixedDraw = unresolved.match(/(?:デッキから|山札から)?\s*(\d+)枚(?:カードを)?(?:ドロー|引く)(?:する)?/);
        const hasDrawChoice = /その中から|引いたカード|引いた中から|好きな順番|それ以外|選択|選び|選ん|以外|ランダム|戻す/.test(unresolved);
        const discardAllDraw = unresolved.match(/(?:自分の)?手札を(?:すべて|全て)捨て、その枚数ドロー(?:する)?/);
        const discardMonsterDraw = unresolved.match(/(?:自分の)?手札のモンスターカードを全て捨てる。その数ドロー(?:する)?/);
        if (discardAllDraw) {
            const count = player.hand.length;
            player.graveyard.push(...player.hand.splice(0));
            const drawn = drawCardsForEffect(playerIndex, count);
            unresolved = unresolved.replace(discardAllDraw[0], '');
            handled = true;
            gameState.logs.push({ type: 'system', message: `自動: 手札を${count}枚墓地へ送り、${drawn}枚ドローしました`, time: Date.now() });
        } else if (discardMonsterDraw) {
            const discarded = player.hand.filter(card => card.card.cardBase === 'monster');
            player.hand = player.hand.filter(card => card.card.cardBase !== 'monster');
            player.graveyard.push(...discarded);
            const drawn = drawCardsForEffect(playerIndex, discarded.length);
            unresolved = unresolved.replace(discardMonsterDraw[0], '');
            handled = true;
            gameState.logs.push({ type: 'system', message: `自動: モンスターカード${discarded.length}枚を墓地へ送り、${drawn}枚ドローしました`, time: Date.now() });
        } else if (shieldBasedDraw) {
            const count = Math.max(0, 5 - player.shield);
            const drawn = drawCardsForEffect(playerIndex, count);
            unresolved = unresolved.replace(shieldBasedDraw[0], '');
            handled = true;
            gameState.logs.push({ type: 'system', message: `自動: シールド数に応じて${drawn}枚ドローしました`, time: Date.now() });
        } else if (opponentCountDraw) {
            const count = [...gameState.players[opponentIndex].field.battle, ...gameState.players[opponentIndex].field.reserve].filter(Boolean).length;
            const drawn = drawCardsForEffect(playerIndex, count);
            unresolved = unresolved.replace(opponentCountDraw[0], '');
            handled = true;
            gameState.logs.push({ type: 'system', message: `自動: 相手のモンスター数に応じて${drawn}枚ドローしました`, time: Date.now() });
        } else if (fixedDraw && !hasDrawChoice) {
            const count = Number(fixedDraw[1]);
            const drawn = drawCardsForEffect(playerIndex, count);
            unresolved = unresolved.replace(fixedDraw[0], '');
            handled = true;
            gameState.logs.push({ type: 'system', message: `自動: ${drawn}枚ドローしました`, time: Date.now() });
        }
    }

    const opponentAllDamage = unresolved.match(/相手の場のモンスター(?:すべて|全て)に(?:HPに)?(\d+)ダメージ/);
    if (opponentAllDamage) {
        const damage = Number(opponentAllDamage[1]);
        ['battle', 'reserve'].forEach(zone => gameState.players[opponentIndex].field[zone].forEach((monster, index) => {
            if (monster) dealDamageToMonster(opponentIndex, zone, index, damage);
        }));
        unresolved = unresolved.replace(opponentAllDamage[0], '');
        handled = true;
    }

    const battlefieldAllDamage = unresolved.match(/(?:バトルゾーン|場)のモンスター(?:すべて|全て)に(?:[^\d。]+属性)?(\d+)ダメージ/);
    if (battlefieldAllDamage && !opponentAllDamage) {
        const damage = Number(battlefieldAllDamage[1]);
        [0, 1].forEach(targetPlayer => gameState.players[targetPlayer].field.battle.forEach((monster, index) => {
            if (monster) dealDamageToMonster(targetPlayer, 'battle', index, damage);
        }));
        unresolved = unresolved.replace(battlefieldAllDamage[0], '');
        handled = true;
    }

    const opponentShieldBreak = unresolved.match(/相手のシールドを(?:すべて|全て)破壊する/);
    if (opponentShieldBreak) {
        const opponent = gameState.players[opponentIndex];
        const removedShields = opponent.shield;
        opponent.shield = 0;
        drawCardsForEffect(opponentIndex, removedShields);
        gameState.logs.push({ type: 'system', message: `自動: ${opponent.id}のシールド${removedShields}枚を破壊しました`, time: Date.now() });
        unresolved = unresolved.replace(opponentShieldBreak[0], '');
        handled = true;
    }

    const opponentPlayerDamage = unresolved.match(/相手のHPに(\d+)ダメージ/);
    if (opponentPlayerDamage) {
        const damage = Number(opponentPlayerDamage[1]);
        const previousHp = gameState.players[opponentIndex].hp;
        gameState.players[opponentIndex].hp = Math.max(0, previousHp - damage);
        if (gameState.players[opponentIndex].hp === 0) gameState.winner = player.id;
        gameState.logs.push({ type: 'system', message: `${gameState.players[opponentIndex].id}のHPが${previousHp}から${gameState.players[opponentIndex].hp}になりました`, time: Date.now() });
        unresolved = unresolved.replace(opponentPlayerDamage[0], '');
        handled = true;
    }

    const selectedMonster = context.target
        ? gameState.players[context.target.playerIndex]?.field[context.target.zone]?.[context.target.index]
        : null;
    if (selectedMonster) {
        const selectionClause = unresolved.match(/(?:(?:自分の|相手の)?場の)?モンスター(?:を1体選び|を1体選ぶ|1体を選び|1体を選択する|1枚を選択する|1体の|1枚の)/);
        if (selectionClause) {
            unresolved = unresolved.replace(selectionClause[0], '');
            handled = true;
        }
        unresolved = unresolved.replace(/HPが\d+以下の/, '');
    }
    const selectedHeal = unresolved.match(/(?:そのモンスターの(?:体力|HP)を|HPを)(\d+)回復(?:する)?/);
    if (selectedMonster && selectedHeal) {
        dealDamageToMonster(context.target.playerIndex, context.target.zone, context.target.index, -Number(selectedHeal[1]));
        unresolved = unresolved.replace(selectedHeal[0], '');
        handled = true;
    }

    const selectedDamage = unresolved.match(/(?:そのモンスター|モンスター1体)に、?(\d+)ダメージ/);
    if (selectedMonster && selectedDamage) {
        dealDamageToMonster(context.target.playerIndex, context.target.zone, context.target.index, Number(selectedDamage[1]));
        unresolved = unresolved.replace(selectedDamage[0], '');
        handled = true;
    }

    const selectedAttackIncrease = unresolved.match(/(?:このターン中、?)?攻撃力を(\d+)(?:上げる|増加する|する)/);
    if (selectedMonster && selectedAttackIncrease) {
        applyMonsterStatModifier(selectedMonster, Number(selectedAttackIncrease[1]), 0, /このターン/.test(unresolved) ? playerIndex : null);
        unresolved = unresolved.replace(selectedAttackIncrease[0], '');
        handled = true;
    }

    const selectedHpIncrease = unresolved.match(/HPを(\d+)(?:上げる|増加する|する)/);
    if (selectedMonster && selectedHpIncrease) {
        applyMonsterStatModifier(selectedMonster, 0, Number(selectedHpIncrease[1]), /このターン/.test(unresolved) ? playerIndex : null);
        unresolved = unresolved.replace(selectedHpIncrease[0], '');
        handled = true;
    }

    if (selectedMonster && /攻撃力とHPは逆転する/.test(unresolved)) {
        selectedMonster.statsSwapped = !selectedMonster.statsSwapped;
        unresolved = unresolved.replace(/攻撃力とHPは逆転する/, '');
        handled = true;
    }

    const ownFieldHeal = unresolved.match(/自分の場の(?:モンスター)?(?:すべて|全て)の(?:モンスターの)?HPを(\d+)回復/);
    if (ownFieldHeal) {
        const healing = Number(ownFieldHeal[1]);
        ['battle', 'reserve'].forEach(zone => gameState.players[playerIndex].field[zone].forEach((monster, index) => {
            if (monster) dealDamageToMonster(playerIndex, zone, index, -healing);
        }));
        unresolved = unresolved.replace(ownFieldHeal[0], '');
        handled = true;
    }

    const selfHeal = unresolved.match(/このモンスターのHPを(?:(\d+)回復|威力だけ回復)/);
    if (selfHeal && context.attacker) {
        const healing = Number(selfHeal[1] || context.damage || 0);
        dealDamageToMonster(playerIndex, context.attacker.zone, context.attacker.index, -healing);
        unresolved = unresolved.replace(selfHeal[0], '');
        handled = true;
    }

    const attackDamageHeal = unresolved.match(/この攻撃で与えたダメージ(?:分|量だけ)、?このモンスターのHPを回復/);
    if (attackDamageHeal && context.attacker) {
        dealDamageToMonster(playerIndex, context.attacker.zone, context.attacker.index, -(context.damage || 0));
        unresolved = unresolved.replace(attackDamageHeal[0], '');
        handled = true;
    }

    const playerDamageHeal = unresolved.match(/(?:この攻撃で与えたダメージ(?:分|量だけ)|威力だけ)自分のHPを回復/);
    if (playerDamageHeal) {
        const amount = context.damage || 0;
        const previous = player.hp;
        player.hp += amount;
        gameState.logs.push({ type: 'system', message: `${player.id}のHPが${previous}から${player.hp}に回復しました`, time: Date.now() });
        unresolved = unresolved.replace(playerDamageHeal[0], '');
        handled = true;
    }

    const playerHeal = unresolved.match(/自分のHPを(\d+)回復/);
    if (playerHeal) {
        const amount = Number(playerHeal[1]);
        const previous = player.hp;
        player.hp += amount;
        gameState.logs.push({ type: 'system', message: `${player.id}のHPが${previous}から${player.hp}に回復しました`, time: Date.now() });
        unresolved = unresolved.replace(playerHeal[0], '');
        handled = true;
    }

    const manaChange = unresolved.match(/(\d+)マナ(?:を)?(回復|増加|減少|失う)/);
    if (manaChange) {
        const amount = Number(manaChange[1]);
        const previous = player.mana;
        player.mana = manaChange[2] === '減少' || manaChange[2] === '失う'
            ? Math.max(0, player.mana - amount)
            : Math.min(player.maxMana, player.mana + amount);
        gameState.logs.push({ type: 'system', message: `${player.id}のマナが${previous}から${player.mana}になりました`, time: Date.now() });
        unresolved = unresolved.replace(manaChange[0], '');
        handled = true;
    }

    const shieldChange = unresolved.match(/(?:自分の)?シールドを(\d+)(増やす|増加|減らす|減少)/);
    if (shieldChange) {
        const amount = Number(shieldChange[1]);
        const delta = shieldChange[2] === '増やす' || shieldChange[2] === '増加' ? amount : -amount;
        const previous = player.shield;
        player.shield = Math.max(0, player.shield + delta);
        const changed = player.shield - previous;
        if (changed < 0) drawCardsForEffect(playerIndex, -changed);
        gameState.logs.push({ type: 'system', message: `${player.id}のシールドが${previous}から${player.shield}になりました`, time: Date.now() });
        unresolved = unresolved.replace(shieldChange[0], '');
        handled = true;
    }

    const temporaryOwner = /次の(?:相手の)?ターン|このターン/.test(unresolved)
        ? (/次の(?:相手の)?ターン/.test(unresolved) ? opponentIndex : playerIndex)
        : null;
    const opponentAttackIncrease = unresolved.match(/相手モンスターの攻撃力は(\d+)する/);
    if (opponentAttackIncrease) {
        const amount = Number(opponentAttackIncrease[1]);
        ['battle', 'reserve'].forEach(zone => gameState.players[opponentIndex].field[zone].forEach(monster => {
            if (monster) applyMonsterStatModifier(monster, amount, 0, temporaryOwner);
        }));
        unresolved = unresolved.replace(opponentAttackIncrease[0], '');
        handled = true;
    }

    const bothStatsIncrease = unresolved.match(/(?:攻撃力とHP|HPと攻撃力)を(\d+)上げる/);
    if (bothStatsIncrease && context.attacker) {
        const amount = Number(bothStatsIncrease[1]);
        const monster = player.field[context.attacker.zone]?.[context.attacker.index];
        applyMonsterStatModifier(monster, amount, amount, temporaryOwner);
        unresolved = unresolved.replace(bothStatsIncrease[0], '');
        handled = true;
    }

    const attackIncrease = unresolved.match(/(?:このモンスターの)?攻撃力(?:は|を)(\d+)(?:上げる|増加する|する)/);
    if (attackIncrease && context.attacker) {
        const monster = player.field[context.attacker.zone]?.[context.attacker.index];
        applyMonsterStatModifier(monster, Number(attackIncrease[1]), 0, temporaryOwner);
        unresolved = unresolved.replace(attackIncrease[0], '');
        handled = true;
    }

    const manaGain = unresolved.match(/(?:自分の)?マナを(\d+)し(?:、|。|$)/);
    if (manaGain) {
        const amount = Number(manaGain[1]);
        const previous = player.mana;
        player.mana = Math.min(player.maxMana, player.mana + amount);
        gameState.logs.push({ type: 'system', message: `${player.id}のマナが${previous}から${player.mana}に増加しました`, time: Date.now() });
        unresolved = unresolved.replace(manaGain[0], '');
        handled = true;
    }

    const extraNormalAttacks = unresolved.match(/通常攻撃を1ターンに\d+回行える/);
    if (extraNormalAttacks) {
        unresolved = unresolved.replace(extraNormalAttacks[0], '');
        handled = true;
    }

    const selfDamage = unresolved.match(/このモンスターは\s*(\d+)ダメージ受ける/);
    if (selfDamage && context.attacker) {
        dealDamageToMonster(playerIndex, context.attacker.zone, context.attacker.index, Number(selfDamage[1]));
        unresolved = unresolved.replace(selfDamage[0], '');
        handled = true;
    }

    return { handled, unresolved: unresolved.replace(/[。．、，,\s]/g, '') };
}

function isAutomaticEffectTextSupported(effectText, context = {}) {
    const text = String(effectText || '').trim();
    if (!text) return false;
    if (parseSimpleDrawEffect({ contentText: text }) !== null) return true;
    if (getEffectTargetPolicy(text) && /(?:回復|ダメージ|攻撃力|HP.*逆転|逆転する)/.test(text)) return true;
    const requiresChoice = /その中から|引いたカード|引いた中から|好きな順番|それ以外|選択|選び|選ん|以外|ランダム|戻す/.test(text);
    if (!requiresChoice && /(?:\d+枚(?:カードを)?(?:ドロー|引く)|相手の場のモンスターの数だけドロー|5\s*[-−]\s*シールドの数だけドロー)/.test(text)) return true;
    const targetEffectSupported = /(?:このモンスターのHPを(?:\d+回復|威力だけ回復)|このモンスターは\s*\d+ダメージ受ける|この攻撃で与えたダメージ(?:分|量だけ)|威力だけ自分のHPを回復|(?:攻撃力とHP|HPと攻撃力)を\d+上げる|攻撃力(?:は|を)\d+(?:上げる|増加する|する))/.test(text);
    if (context.attacker && targetEffectSupported) return true;
    if (getEffectCardChoicePolicy(text)) return true;
    return /(?:手札を(?:すべて|全て)捨て、その枚数ドロー|手札のモンスターカードを全て捨てる。その数ドロー|相手の場のモンスターの数だけドロー|相手の場のモンスター(?:すべて|全て)に(?:HPに)?\d+ダメージ|(?:バトルゾーン|場)のモンスター(?:すべて|全て)に|自分の場の(?:モンスター)?(?:すべて|全て).*HPを\d+回復|威力だけ自分のHPを回復|自分のHPを\d+回復|\d+マナ(?:を)?(?:回復|増加|減少|失う)|マナを\d+し|シールドを\d+(?:増やす|増加|減らす|減少)|相手のシールドを(?:すべて|全て)破壊|相手のHPに\d+ダメージ|相手モンスターの攻撃力は\d+する|通常攻撃を1ターンに\d+回行える)/.test(text);
}

function destroyMonster(playerIndex, zone, index) {
    const player = gameState.players[playerIndex];
    const monster = player.field[zone][index];
    if (!monster) return;

    player.field[zone][index] = null;
    monster.currentDamage = 0;
    player.graveyard.push(monster);
    gameState.logs.push({
        type: 'system',
        message: `${monster.card.cardName}が破壊され、墓地へ送られました`,
        revealCardNames: true,
        time: Date.now()
    });

    if (player.shield > 0) {
        player.shield--;
        const drawnCard = drawCardForPlayer(playerIndex);
        gameState.logs.push({
            type: 'system',
            message: `${player.id}のシールドが1減少しました${drawnCard ? '。カードを1枚ドローしました' : ''}`,
            time: Date.now()
        });
    }
}

function dealDamageToMonster(playerIndex, zone, index, amount) {
    const monster = gameState.players[playerIndex].field[zone][index];
    if (!monster) return false;

    const adjustedAmount = amount > 0 ? applyPassiveDamageModifiers(monster, amount) : amount;
    monster.currentDamage = Math.max(0, (monster.currentDamage || 0) + adjustedAmount);
    gameState.logs.push({
        type: 'system',
        message: adjustedAmount >= 0
            ? `${monster.card.cardName}に${adjustedAmount}ダメージを与えました(累積: ${monster.currentDamage})`
            : `${monster.card.cardName}が${-adjustedAmount}回復しました(累積: ${monster.currentDamage})`,
        revealCardNames: true,
        time: Date.now()
    });

    if (monster.card.hp !== undefined && monster.currentDamage >= getMonsterMaxHp(monster)) {
        destroyMonster(playerIndex, zone, index);
    }
    return true;
}

function getMonsterStatModifier(monster, stat) {
    const permanent = Number(monster?.[`${stat}Modifier`] || 0);
    const temporary = (monster?.temporaryModifiers || []).reduce((total, modifier) => total + Number(modifier[stat] || 0), 0);
    return permanent + temporary;
}

function getMonsterAttack(monster) {
    const attack = Number(monster?.card?.attack) || 0;
    const hp = Number(monster?.card?.hp) || 0;
    return Math.max(0, (monster?.statsSwapped ? hp : attack) + getMonsterStatModifier(monster, 'attack'));
}

function getMonsterMaxHp(monster) {
    const attack = Number(monster?.card?.attack) || 0;
    const hp = Number(monster?.card?.hp) || 0;
    return Math.max(0, (monster?.statsSwapped ? attack : hp) + getMonsterStatModifier(monster, 'hp'));
}

function applyMonsterStatModifier(monster, attack, hp, expiresAtPlayer = null) {
    if (!monster) return;
    if (expiresAtPlayer === null) {
        monster.attackModifier = Number(monster.attackModifier || 0) + attack;
        monster.hpModifier = Number(monster.hpModifier || 0) + hp;
    } else {
        if (!Array.isArray(monster.temporaryModifiers)) monster.temporaryModifiers = [];
        monster.temporaryModifiers.push({ attack, hp, expiresAtPlayer });
    }
    if (monster.currentDamage >= getMonsterMaxHp(monster)) {
        const position = findMonsterPosition(monster);
        if (position) destroyMonster(position.playerIndex, position.zone, position.index);
    }
}

function findMonsterPosition(target) {
    for (let playerIndex = 0; playerIndex < gameState.players.length; playerIndex++) {
        for (const zone of ['battle', 'reserve']) {
            const index = gameState.players[playerIndex].field[zone].indexOf(target);
            if (index !== -1) return { playerIndex, zone, index };
        }
    }
    return null;
}

function expireTemporaryModifiers(playerIndex) {
    gameState.players.forEach(player => ['battle', 'reserve'].forEach(zone => {
        player.field[zone].forEach((monster, index) => {
            if (!monster?.temporaryModifiers) return;
            const expired = monster.temporaryModifiers.some(modifier => modifier.expiresAtPlayer === playerIndex);
            monster.temporaryModifiers = monster.temporaryModifiers.filter(modifier => modifier.expiresAtPlayer !== playerIndex);
            if (expired && monster.currentDamage >= getMonsterMaxHp(monster)) destroyMonster(gameState.players.indexOf(player), zone, index);
        });
    }));
}

function applyPassiveDamageModifiers(target, amount) {
    let increasedDamage = 0;
    let reducedDamage = 0;
    [0, 1].forEach(playerIndex => {
        ['battle', 'reserve'].forEach(zone => gameState.players[playerIndex].field[zone].forEach(source => {
            if (!source) return;
            (source.card.skills || []).filter(skill => skill.type === 'P').forEach(skill => {
                const text = skill.text || '';
                if (text.includes('このターン')) return;
                const increase = text.match(/場の(さばる族でない)?モンスターの受けるダメージは(\d+)増加/);
                if (increase && (!increase[1] || target.card.tribe !== 'さばる族')) increasedDamage += Number(increase[2]);
                const reduction = text.match(/場の(さばる族)?モンスターの受けるダメージは(\d+)(?:減少|減る)/);
                if (reduction && (!reduction[1] || target.card.tribe === 'さばる族')) reducedDamage += Number(reduction[2]);
            });
        }));
    });
    return Math.max(0, amount + increasedDamage - reducedDamage);
}

function attributeDamageBonus(attackerCard, defenderCard) {
    const advantage = { mizu: 'hi', ti: 'mizu', kaze: 'ti', hi: 'kaze', hikari: 'yami', yami: 'hikari' };
    return advantage[attackerCard?.attribute] === defenderCard?.attribute ? 20 : 0;
}

function maximumNormalAttacks(monster) {
    const passiveAttacks = (monster?.card?.skills || [])
        .filter(skill => skill.type === 'P')
        .map(skill => Number(skill.text?.match(/通常攻撃を1ターンに(\d+)回/)?.[1] || 1));
    return Math.max(1, ...passiveAttacks);
}

function directAttackDamage(monster) {
    const passive = (monster?.card?.skills || []).find(skill => skill.type === 'P' && /直接攻撃のダメージが\d+ダメージ/.test(skill.text || ''));
    return Number(passive?.text.match(/直接攻撃のダメージが(\d+)ダメージ/)?.[1] || 1);
}

function canMonsterAttack(monster) {
    if (!monster) return false;
    const usedAttacks = Number.isInteger(monster.attacksUsed)
        ? monster.attacksUsed
        : monster.hasAttacked ? maximumNormalAttacks(monster) : 0;
    return usedAttacks < maximumNormalAttacks(monster);
}

function recordMonsterAttack(monster) {
    monster.attacksUsed = (Number.isInteger(monster.attacksUsed)
        ? monster.attacksUsed
        : monster.hasAttacked ? maximumNormalAttacks(monster) : 0) + 1;
    monster.hasAttacked = !canMonsterAttack(monster);
}

function resetAttacksForPlayer(playerIndex) {
    const field = gameState.players[playerIndex].field;
    [...field.battle, ...field.reserve].forEach(monster => {
        if (monster) {
            monster.hasAttacked = false;
            monster.attacksUsed = 0;
        }
    });
}

function parseAttackSkill(skill) {
    const name = skill?.name || '';
    const damageMatch = name.match(/D\s*(\d+)(?:\s*[×xX]\s*(\d+))?/i);
    const costMatch = name.match(/C\s*(\d+)/i);
    const effectOnly = !damageMatch && /(?:すべて|全て).*?\d+ダメージ/.test(skill?.text || '');
    if (!damageMatch && !effectOnly) return null;

    return {
        damage: Number(damageMatch?.[1] || 0),
        hits: Number(damageMatch?.[2] || 1),
        cost: Number(costMatch?.[1] || 0),
        effectOnly
    };
}

function describeAttackTarget(target) {
    if (target?.direct) return '相手プレイヤー';
    if (!target) return '対象なし';
    const owner = gameState.players[target.playerIndex]?.id || '相手';
    const zoneName = target.zone === 'reserve' ? '控え' : 'バトル';
    return `${owner}${zoneName}${target.index + 1}`;
}

function getEffectTargetPolicy(effectText) {
    const text = String(effectText || '');
    if (!/(?:(?:自分の|相手の)?場のモンスター(?:1体|1枚|を1体|を1枚)|そのモンスター)/.test(text)) return null;
    if (/相手の場/.test(text)) return { playerIndexes: [0], allowReserve: true };
    if (/自分の場/.test(text)) return { playerIndexes: [1], allowReserve: true };
    if (/場のモンスター/.test(text)) return { playerIndexes: [0, 1], allowReserve: true };
    return null;
}

function getEffectCardChoicePolicy(effectText) {
    const text = String(effectText || '');
    const sources = [];
    if (/(?:墓地|墓場)/.test(text)) sources.push('graveyard');
    if (/(?:デッキ|山札)/.test(text)) sources.push('deck');
    if (/EX/.test(text)) sources.push('ex');
    const source = sources[0] || null;
    const destination = /手札に加える/.test(text) ? 'hand'
        : /場に出す|場に召喚/.test(text) ? 'field'
            : /墓地(?:へ|に)送る|墓場(?:へ|に)送る/.test(text) ? 'graveyard'
                : /EXデッキに戻す/.test(text) ? 'ex' : null;
    if (!source || !destination) return null;

    const nameContains = text.match(/カード名に「([^」]+)」を含む/);
    const excludedName = text.match(/カード名に「([^」]+)」を含まない/);
    const quotedNames = [...text.matchAll(/[「『]([^」』]+)[」』]/g)].map(match => match[1]);
    const tribe = text.match(/(さばる族|あやし族|ろきさ族|みかん族|そらみ族|とやま族)/);
    const cardBase = /魔法カード/.test(text) ? 'magic' : /サポーター/.test(text) ? 'supporter' : /モンスター/.test(text) ? 'monster' : null;
    const requiresHpText = /「HP」の記述/.test(text);
    return {
        source,
        sources,
        owner: /相手の(?:墓地|墓場|デッキ|山札)/.test(text) ? 0 : 1,
        destination,
        nameContains: nameContains?.[1] || null,
        excludedName: excludedName?.[1] || null,
        exactNames: nameContains || excludedName ? [] : quotedNames,
        tribe: tribe?.[1] || null,
        cardBase,
        requiresHpText
    };
}

function normalizeCardName(name) {
    return String(name || '').normalize('NFKC').replace(/\s/g, '');
}

function requiresEffectChoice(effectText) {
    return !!(getEffectTargetPolicy(effectText) || getEffectCardChoicePolicy(effectText));
}

function getEffectCardCandidates(policy, playerIndex) {
    const player = gameState.players[policy.owner ?? playerIndex];
    return (policy.sources || [policy.source]).flatMap(source => (player[source] || [])
        .filter(card => {
            const data = card.card;
            const normalizedName = normalizeCardName(data.cardName);
            if (policy.nameContains && !normalizedName.includes(normalizeCardName(policy.nameContains))) return false;
            if (policy.excludedName && normalizedName.includes(normalizeCardName(policy.excludedName))) return false;
            if (policy.exactNames.length && !policy.exactNames.some(name => normalizeCardName(name) === normalizedName)) return false;
            if (policy.tribe && data.tribe !== policy.tribe) return false;
            if (policy.cardBase && data.cardBase !== policy.cardBase) return false;
            if (policy.requiresHpText && !getCardEffectText(data).includes('HP')) return false;
            return true;
        }).map(card => ({ source, card })));
}

function showEffectCardChoice(title, candidates, callback) {
    const modal = document.getElementById('targetModal');
    const modalTitle = document.getElementById('targetModalTitle');
    const targetGrid = document.getElementById('targetGrid');
    const confirmBtn = document.getElementById('targetConfirmBtn');
    modalTitle.textContent = title;
    targetGrid.innerHTML = '';
    let selectedCard = null;
    candidates.forEach(candidate => {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.className = 'target-cell';
        choice.textContent = candidate.card.card.cardName;
        choice.addEventListener('click', () => {
            targetGrid.querySelectorAll('.target-cell').forEach(cell => cell.classList.remove('selected'));
            choice.classList.add('selected');
            selectedCard = candidate;
            confirmBtn.disabled = false;
        });
        targetGrid.appendChild(choice);
    });
    confirmBtn.disabled = true;
    confirmBtn.onclick = () => {
        if (!selectedCard) return;
        modal.classList.remove('active');
        callback(selectedCard);
    };
    modal.classList.add('active');
}

function selectAutomaticEffectTarget(effectText, title, callback) {
    const policy = getEffectTargetPolicy(effectText);
    if (!policy) {
        const cardPolicy = getEffectCardChoicePolicy(effectText);
        if (!cardPolicy) {
            callback(null);
            return;
        }
        const allCandidates = getEffectCardCandidates(cardPolicy, 1);
        const candidates = [...new Map(allCandidates.map(candidate => [normalizeCardName(candidate.card.cardName), candidate])).values()];
        if (candidates.length === 1) {
            callback(null, { policy: cardPolicy, source: candidates[0].source, card: candidates[0].card });
        } else if (candidates.length > 1) {
            showEffectCardChoice(title, candidates, candidate => callback(null, { policy: cardPolicy, source: candidate.source, card: candidate.card }));
        } else {
            gameState.logs.push({ type: 'system', message: `効果対象が見つかりません: ${title}`, time: Date.now() });
            callback(null, { policy: cardPolicy, card: null });
        }
        return;
    }
    showTargetSelection(title, target => callback(target, null), { ...policy, allowDirect: false, effectText });
}

function moveSelectedEffectCard(playerIndex, choice) {
    if (!choice?.card || !choice.policy) return false;
    const ownerIndex = choice.policy.owner ?? playerIndex;
    const player = gameState.players[ownerIndex];
    const sourceCards = player[choice.source || choice.policy.source];
    const sourceIndex = sourceCards.indexOf(choice.card);
    if (sourceIndex === -1) return false;

    const [card] = sourceCards.splice(sourceIndex, 1);
    if (choice.policy.destination === 'hand') {
        player.hand.push(card);
    } else if (choice.policy.destination === 'graveyard') {
        player.graveyard.push(card);
    } else if (choice.policy.destination === 'ex') {
        player.ex.push(card);
    } else if (choice.policy.destination === 'deck') {
        player.deck.push(card);
        shuffleDeck(playerIndex);
    } else if (choice.policy.destination === 'field') {
        if (card.card.cardBase !== 'monster' && card.card.cardBase !== 'ex') {
            sourceCards.splice(sourceIndex, 0, card);
            return false;
        }
        if (card.card.monsterType === '特殊進化') {
            const sourceName = normalizeCardName(card.card.evolutionSource?.replace(/[「」]/g, '') || '');
            const positions = ['battle', 'reserve'].flatMap(zone => player.field[zone].map((monster, index) => ({ zone, index, monster })))
                .filter(position => position.monster && sourceName.includes(normalizeCardName(position.monster.card.cardName)));
            if (!positions.length) {
                sourceCards.splice(sourceIndex, 0, card);
                return false;
            }
            const underCard = positions[0].monster;
            player.field[positions[0].zone][positions[0].index] = card;
            card.underCard = underCard;
        } else if (card.card.monsterType === '進化') {
            const sources = findEvolutionSourcePositions(ownerIndex, card.card);
            const zone = 'battle';
            const index = player.field[zone].findIndex(monster => !monster);
            if (!sources || index === -1) {
                sourceCards.splice(sourceIndex, 0, card);
                return false;
            }
            sources.sort((left, right) => left.zone.localeCompare(right.zone) || right.index - left.index).forEach(position => {
                const sourceMonster = player.field[position.zone][position.index];
                player.field[position.zone][position.index] = null;
                sourceMonster.currentDamage = 0;
                player.graveyard.push(sourceMonster);
            });
            player.field[zone][index] = card;
        } else {
            const zone = 'battle';
            const index = player.field[zone].findIndex(monster => !monster);
            if (index === -1) {
                sourceCards.splice(sourceIndex, 0, card);
                return false;
            }
            player.field[zone][index] = card;
        }
        if (!findMonsterPosition(card)) {
            sourceCards.splice(sourceIndex, 0, card);
            return false;
        }
        resolveSemiAutoOnEnter(card, ownerIndex);
    }

    gameState.logs.push({
        type: 'system',
        message: `${player.id}が効果で「${card.card.cardName}」を${choice.policy.destination === 'hand' ? '手札に加えました' : choice.policy.destination === 'field' ? '場に出しました' : choice.policy.destination === 'graveyard' ? '墓地へ送りました' : choice.policy.destination === 'ex' ? 'EXへ戻しました' : 'デッキに戻しました'}`,
        revealCardNames: choice.policy.destination === 'field',
        time: Date.now()
    });
    if (gameState.operationMode !== 'public' && ownerIndex === 1 && ['hand', 'field'].includes(choice.policy.destination)) {
        gameState.privateLogs.push({ type: 'private', message: `効果で移動したカード: ${card.card.cardName}`, time: Date.now() });
    }
    return true;
}

function parseSimpleDrawEffect(card) {
    const text = (card?.contentText || '').trim();
    const match = text.match(/^(?:(?:デッキ|山札)から\s*)?(?:カードを\s*)?(\d+)枚(?:ドロー|引く)(?:する)?[。.!！]*$/);
    return match ? Number(match[1]) : null;
}

function resolveSimpleDrawEffect(card, playerIndex) {
    const drawCount = parseSimpleDrawEffect(card);
    const player = gameState.players[playerIndex];
    if (drawCount === null) {
        gameState.logs.push({ type: 'system', message: `「${card.cardName}」はセミオート未対応です。効果: ${getCardEffectText(card)}。手動で処理してください`, time: Date.now() });
        return;
    }

    let actualDraws = 0;
    for (let drawIndex = 0; drawIndex < drawCount; drawIndex++) {
        const drawnCard = drawCardForPlayer(playerIndex);
        if (!drawnCard) {
            gameState.winner = gameState.players[1 - playerIndex].id;
            gameState.logs.push({ type: 'system', message: `${player.id}がライブラリアウトで敗北しました。${gameState.winner}の勝利です`, time: Date.now() });
            break;
        }
        actualDraws++;
    }
    gameState.logs.push({ type: 'system', message: `セミオート: ${actualDraws}枚ドローしました`, time: Date.now() });
}

function resolveSemiAutoOnEnter(cardInstance, playerIndex) {
    if (gameState.playMode !== 'semi-auto' || !cardInstance?.card?.skills) return;

    cardInstance.card.skills.forEach(skill => {
        if (skill.type !== 'P' || !/場に出た時|場に出た際/.test(skill.text || '')) return;
        if (/発動できる/.test(skill.text || '')) return;
        const effectText = skill.text.replace(/このカードが場に出た(?:時|際)に発動する[。．]?/, '');
        const result = resolveAutomaticEffectText(effectText, playerIndex, { card: cardInstance.card });
        gameState.logs.push({
            type: 'system',
            message: `自動: ${cardInstance.card.cardName}のPスキル「${skill.name}」を処理しました${result.unresolved ? `。未処理: ${result.unresolved}` : ''}`,
            revealCardNames: true,
            time: Date.now()
        });
    });
}

// カード画像のパスを取得
function getCardImagePath(card) {
    if (!card || !card.card) return 'img/monster.png';
    
    const cardName = card.card.cardName.replace(/[\/\\:*?"<>|]/g, '');
    const imagePath = `cardimg/${cardName}.png`;
    
    let defaultImage = 'img/monster.png';
    if (card.card.cardBase === 'ex') {
        defaultImage = 'img/ex.png';
    } else if (card.card.cardBase === 'magic') {
        defaultImage = 'img/magic.png';
    } else if (card.card.cardBase === 'supporter') {
        defaultImage = 'img/supporter.png';
    }
    
    return { primary: imagePath, fallback: defaultImage, showName: false };
}

// カード詳細を表示
function displayCardDetail(card, source) {
    if (!card || !card.card) {
        document.getElementById('cardDetailName').textContent = 'カード未選択';
        document.getElementById('cardDetailStats').innerHTML = '<span>種類: -</span>';
        document.getElementById('cardDetailBody').innerHTML = '<div class="detail-section"><div class="detail-label">説明</div><div class="detail-content">カードを選択すると詳細が表示されます</div></div>';
        document.getElementById('cardDetailImage').src = 'img/monster.png';
        return;
    }
    
    const c = card.card;
    
    document.getElementById('cardDetailName').textContent = c.cardName;
    
    let statsHTML = `<span>種類: ${translate('cardBase', c.cardBase)}</span>`;
    if (c.attribute) statsHTML += `<span>属性: ${translate('attribute', c.attribute)}</span>`;
    if (c.monsterType) statsHTML += `<span>タイプ: ${translate('monsterType', c.monsterType)}</span>`;
    
    if (c.cardBase === 'monster' || c.cardBase === 'ex') {
        const isFieldCard = source === 'field' || source === 'opponent-field';
        if (c.attack !== undefined) statsHTML += `<span>⚔️ ${isFieldCard ? getMonsterAttack(card) : c.attack}</span>`;
        if (c.hp !== undefined) statsHTML += `<span>❤️ ${isFieldCard ? getMonsterMaxHp(card) : c.hp}</span>`;
        if (card.currentDamage) statsHTML += `<span>累積ダメージ: ${card.currentDamage}</span>`;
    }
    
    if ((c.cardBase === 'magic' || c.cardBase === 'supporter') && c.magicCost !== undefined) {
        statsHTML += `<span>💎 ${c.magicCost}</span>`;
    }
    
    document.getElementById('cardDetailStats').innerHTML = statsHTML;
    
    let bodyHTML = '';
    if (c.tribe) {
        bodyHTML += `<div class="detail-section"><div class="detail-label">種族</div><div class="detail-content">${c.tribe}</div></div>`;
    }
    if (c.evolutionSource) {
        bodyHTML += `<div class="detail-section"><div class="detail-label">進化元</div><div class="detail-content">${c.evolutionSource}</div></div>`;
    }
    if (c.magicCost !== undefined && c.cardBase !== 'supporter') {
        bodyHTML += `<div class="detail-section"><div class="detail-label">コスト</div><div class="detail-content">${c.magicCost}</div></div>`;
    }
    if (c.contentText) {
        bodyHTML += `<div class="detail-section"><div class="detail-label">効果</div><div class="detail-content">${c.contentText}</div></div>`;
    }
    if (c.skills && c.skills.length > 0) {
        c.skills.forEach(skill => {
            const skillType = skill.type === 'A' ? 'アタックスキル' : 'パッシブスキル';
            const skillLabel = skillNameMode === 'name' && skill.name?.trim()
                ? `${skillType}: ${skill.name}`
                : `${skillType} ${getSkillDisplayName(c, skill).split(' ').at(-1)}`;
            bodyHTML += `<div class="detail-section"><div class="detail-label">${skillLabel}</div><div class="detail-content">${skill.text || '-'}</div></div>`;
        });
    }
    if (c.supplementText) {
        bodyHTML += `<div class="detail-section"><div class="detail-label">補足</div><div class="detail-content">${c.supplementText}</div></div>`;
    }
    document.getElementById('cardDetailBody').innerHTML = bodyHTML || '<div class="detail-section"><div class="detail-label">説明</div><div class="detail-content">-</div></div>';
    
    const imgData = getCardImagePath(card);
    const img = document.getElementById('cardDetailImage');
    img.src = imgData.primary;
    img.style.cursor = 'pointer';
    img.onerror = () => { img.src = imgData.fallback; };
    
    img.onclick = () => {
        document.getElementById('imageModalContent').src = img.src;
        document.getElementById('imageModal').classList.add('active');
    };
}

// UIを更新
function renderUI() {
    const playerTurn = isCurrentPlayerTurn();
    document.body.classList.toggle('solo-mode', gameState.soloMode);
    document.body.classList.toggle('semi-auto-mode', isSemiAutoMode());
    document.getElementById('playModeSelect').value = gameState.playMode;
    document.getElementById('operationModeSelect').value = gameState.operationMode;
    document.getElementById('skillNameModeSelect').value = skillNameMode;
    
    const statusValues = document.querySelectorAll('.status-value');
    const statusLabels = document.querySelectorAll('.status-label');
    const opponentId = gameState.players[0].id;
    const playerId = gameState.players[1].id;
    statusLabels[0].textContent = gameState.soloMode ? '練習用 HP:' : `${opponentId} HP:`;
    statusLabels[3].textContent = `${playerId} HP:`;
    document.getElementById('decreaseOpponentHpBtn').setAttribute('aria-label', `${opponentId}のHPを1減らす`);
    document.getElementById('decreasePlayerHpBtn').setAttribute('aria-label', `${playerId}のHPを1減らす`);
    document.getElementById('increaseOpponentHpBtn').setAttribute('aria-label', `${opponentId}のHPを1増やす`);
    document.getElementById('increasePlayerHpBtn').setAttribute('aria-label', `${playerId}のHPを1増やす`);
    document.getElementById('decreaseOpponentShieldBtn').setAttribute('aria-label', `${opponentId}のシールドを1減らす`);
    document.getElementById('increaseOpponentShieldBtn').setAttribute('aria-label', `${opponentId}のシールドを1増やす`);
    document.getElementById('decreasePlayerShieldBtn').setAttribute('aria-label', `${playerId}のシールドを1減らす`);
    document.getElementById('increasePlayerShieldBtn').setAttribute('aria-label', `${playerId}のシールドを1増やす`);
    document.getElementById('decreaseOpponentHpBtn').disabled = gameState.winner !== null || gameState.players[0].hp <= 0;
    document.getElementById('increaseOpponentHpBtn').disabled = gameState.winner !== null;
    document.getElementById('decreasePlayerHpBtn').disabled = gameState.winner !== null || gameState.players[1].hp <= 0;
    document.getElementById('increasePlayerHpBtn').disabled = gameState.winner !== null;
    document.getElementById('decreaseOpponentShieldBtn').disabled = gameState.winner !== null || gameState.players[0].shield <= 0;
    document.getElementById('increaseOpponentShieldBtn').disabled = gameState.winner !== null;
    document.getElementById('decreasePlayerShieldBtn').disabled = gameState.winner !== null || gameState.players[1].shield <= 0;
    document.getElementById('increasePlayerShieldBtn').disabled = gameState.winner !== null;
    statusValues[0].textContent = gameState.players[0].hp;
    statusValues[1].textContent = gameState.players[0].shield;
    statusValues[2].textContent = `${gameState.players[0].mana}/${gameState.players[0].maxMana}`;
    statusValues[3].textContent = gameState.players[1].hp;
    statusValues[4].textContent = gameState.players[1].shield;
    statusValues[5].textContent = `${gameState.players[1].mana}/${gameState.players[1].maxMana}`;
    
    const turnText = playerTurn ? 'あなたのターン' : '相手のターン';
    document.getElementById('turnStatus').textContent = `${gameState.turn} - ${turnText}`;

    const logDisplay = document.getElementById('logDisplay');
    logDisplay.innerHTML = '';
    
    // プライベートログと通常ログを統合して時間順に表示
    const allLogs = [...gameState.privateLogs.map(log => ({ ...log, type: gameState.operationMode === 'public' ? 'system' : 'private' })), ...gameState.logs].sort((a, b) => a.time - b.time);
    
    allLogs.forEach(log => {
        const entry = document.createElement('div');
        entry.className = `log-entry ${log.type}`;
        const labelText = {
            'system': '[システム]',
            '1P': '[1P]',
            '2P': '[2P]',
            'chat': `[${log.playerId || '1P'}][C]`,
            'private': '[自分専用]'
        }[log.type] || '';
        
        const timeStr = new Date(log.time).toLocaleTimeString('ja-JP', { 
            hour: '2-digit', 
            minute: '2-digit',
            second: '2-digit'
        });
        
        const revealNames = gameState.operationMode === 'public' || log.type === 'private' || (gameState.operationMode === 'auto' && log.revealCardNames === true);
        const safeMessage = formatSkillNamesForDisplay(revealNames
            ? log.message
            : redactCardNames(log.message));
        entry.innerHTML = `<span class="log-time">${timeStr}</span><span class="log-label">${labelText}</span><span>${safeMessage}</span>`;
        logDisplay.appendChild(entry);
    });
    logDisplay.scrollTop = logDisplay.scrollHeight;

    const zoneToggleBtn = document.getElementById('zoneToggleBtn');
    const zoneNames = {
        'hand': '手札',
        'free': 'フリー',
        'graveyard': '墓地確認',
        'deck': '山札確認',
        'ex': 'EX確認'
    };
    zoneToggleBtn.textContent = zoneNames[gameState.handZoneMode] || '手札';

    renderCards();
    renderField();
    updateMenuButtons();
    updateCounterApplyButton();
    updateUIInteractivity(playerTurn);
    updateGameStartButton();
    sendGameState();
}

// カード表示
// renderCards関数を修正
function renderCards() {
    const handZone = document.getElementById('handZone');
    const toggleBtn = document.getElementById('zoneToggleBtn');
    const menuToggle = document.getElementById('menuToggle');
    
    Array.from(handZone.children).forEach(child => {
        if (child !== toggleBtn && child !== menuToggle) {
            child.remove();
        }
    });

    let cardsToShow = [];
    let sourceType = 'hand';
    
    switch(gameState.handZoneMode) {
        case 'hand':
            cardsToShow = gameState.players[1].hand;
            sourceType = 'hand';
            break;
        case 'free':
            cardsToShow = gameState.players[1].free || [];
            sourceType = 'free';
            break;
        case 'graveyard':
            cardsToShow = gameState.players[1].graveyard;
            sourceType = 'graveyard';
            toggleBtn.textContent = '墓地確認中';
            break;
        case 'deck':
            cardsToShow = gameState.players[1].deck;
            sourceType = 'deck';
            toggleBtn.textContent = '山札確認中';
            break;
        case 'ex':
            cardsToShow = gameState.players[1].ex;
            sourceType = 'ex';
            toggleBtn.textContent = 'EX確認中';
            break;
        case 'opponent-graveyard-view':
            cardsToShow = gameState.players[0].graveyard;
            sourceType = 'opponent-graveyard';
            toggleBtn.textContent = '相手墓地確認中';
            break;
        case 'opponent-deck-view':
            cardsToShow = gameState.players[0].deck;
            sourceType = 'opponent-deck';
            toggleBtn.textContent = '相手山札確認中';
            break;
        case 'opponent-ex-view':
            cardsToShow = gameState.players[0].ex;
            sourceType = 'opponent-ex';
            toggleBtn.textContent = '相手EX確認中';
            break;
    }
    
    // 確認モード時はボタンを手札に戻るボタンに変更
    if (['graveyard', 'deck', 'ex', 'opponent-graveyard-view', 'opponent-deck-view', 'opponent-ex-view'].includes(gameState.handZoneMode)) {
        toggleBtn.textContent = '手札表示に戻る';
        toggleBtn.onclick = () => {
            gameState.handZoneMode = 'hand';
            gameState.selectedCard = null;
            gameState.selectedCardSource = null;
            renderUI();
        };
    } else {
        // 通常モード時は元のトグル機能
        const zoneNames = {
            'hand': '手札',
            'free': 'フリー'
        };
        toggleBtn.textContent = zoneNames[gameState.handZoneMode] || '手札';
        toggleBtn.onclick = () => {
            const modes = ['hand', 'free'];
            const currentIndex = modes.indexOf(gameState.handZoneMode);
            const nextIndex = (currentIndex + 1) % modes.length;
            gameState.handZoneMode = modes[nextIndex];
            gameState.selectedCard = null;
            gameState.selectedCardSource = null;
            gameState.selectedFieldCell = null;
            gameState.selectedFieldPosition = null;
            document.querySelectorAll('.field-area .field-cell').forEach(c => c.classList.remove('selected'));
            document.querySelectorAll('.field-grid .field-cell').forEach(c => c.classList.remove('selected'));
            renderUI();
        };
    }
    
    cardsToShow.forEach((card, index) => {
        if (sourceType === 'opponent-deck' && gameState.operationMode !== 'public') {
            const hiddenCard = document.createElement('div');
            hiddenCard.className = 'hand-card concealed-opponent-card';
            hiddenCard.setAttribute('aria-label', '非公開カード');
            hiddenCard.textContent = '非公開';
            handZone.insertBefore(hiddenCard, menuToggle);
            return;
        }

        const cardDiv = document.createElement('div');
        cardDiv.className = 'hand-card';
        cardDiv.dataset.index = index;
        cardDiv.dataset.source = sourceType;
        
        if (gameState.mulliganPhase && sourceType === 'hand' && gameState.mulliganSelected.includes(index)) {
            cardDiv.classList.add('selected');
        }
        
        if (gameState.selectedCard === card && gameState.selectedCardSource === sourceType) {
            cardDiv.classList.add('selected');
        }
        
        const imgData = getCardImagePath(card);
        const img = document.createElement('img');
        img.src = imgData.primary;
        img.onerror = () => {
            img.src = imgData.fallback;
            if (!cardDiv.querySelector('.hand-card-name')) {
                const nameDiv = document.createElement('div');
                nameDiv.className = 'hand-card-name';
                nameDiv.textContent = card.card ? card.card.cardName : 'カード';
                cardDiv.appendChild(nameDiv);
            }
        };
        cardDiv.appendChild(img);
        
        cardDiv.addEventListener('click', () => {
            if (gameState.mulliganPhase && sourceType === 'hand') {
                const idx = gameState.mulliganSelected.indexOf(index);
                if (idx > -1) {
                    gameState.mulliganSelected.splice(idx, 1);
                } else {
                    gameState.mulliganSelected.push(index);
                }
                updateActionPanel('mulligan');
                renderCards();
                renderUI();
            } else {
                document.querySelectorAll('.hand-card').forEach(c => c.classList.remove('selected'));
                cardDiv.classList.add('selected');
                gameState.selectedCard = card;
                gameState.selectedCardSource = sourceType;

                if (!gameState.mulliganPhase) {
                    document.querySelectorAll('.field-area .field-cell').forEach(c => c.classList.remove('selected'));
                    document.querySelectorAll('.field-grid .field-cell').forEach(c => c.classList.remove('selected'));
                    gameState.selectedFieldCell = null;
                    gameState.selectedFieldPosition = null;
                    updateCounterApplyButton();
                }

                displayCardDetail(card, sourceType);
                updateActionPanel(sourceType);
            }
        });
        
        handZone.insertBefore(cardDiv, menuToggle);
    });
}


// フィールド描画
function renderField() {
    // 自分の場の描画
    document.querySelectorAll('.field-area:not(.opponent) .field-cell').forEach(cell => {
        const zone = cell.dataset.zone;
        
        if (zone === 'counter') {
            const existing = cell.querySelector('img.field-monster');
            if (existing) existing.remove();
            
            const counterCard = gameState.players[1].field.counter;
            const img = cell.querySelector('img');
            if (counterCard) {
                if (img) {
                    img.src = 'img/reverse.png';
                    img.style.display = 'block';
                }
            } else {
                if (img) {
                    img.style.display = 'none';
                }
            }
        } else if (zone === 'battle' || zone === 'reserve') {
            const siblings = Array.from(document.querySelectorAll(`.field-area:not(.opponent) .field-cell[data-zone="${zone}"]`));
            const idx = siblings.indexOf(cell);
            const monster = gameState.players[1].field[zone][idx];

            const existing = cell.querySelector('img.field-monster');
            if (existing) existing.remove();
            const overlay = cell.querySelector('.field-overlay');
            if (overlay && !monster) overlay.remove();
            const nameEl = cell.querySelector('.field-card-name');
            if (nameEl && !monster) nameEl.remove();

            if (monster) {
                const imgData = getCardImagePath(monster);
                const img = document.createElement('img');
                img.className = 'field-monster';
                img.src = imgData.primary;
                img.alt = monster.card.cardName || 'モンスター';
                img.onload = () => {
                    const n = cell.querySelector('.field-card-name');
                    if (n) n.remove();
                };
                img.onerror = () => {
                    img.src = imgData.fallback;
                    if (!cell.querySelector('.field-card-name')) {
                        const nameDiv = document.createElement('div');
                        nameDiv.className = 'field-card-name';
                        nameDiv.textContent = monster.card.cardName || '';
                        cell.appendChild(nameDiv);
                    }
                };
                cell.insertBefore(img, cell.firstChild);

                let ov = cell.querySelector('.field-overlay');
                if (!ov) {
                    ov = document.createElement('div');
                    ov.className = 'field-overlay';
                    cell.appendChild(ov);
                }
                const hp = monster.card.hp !== undefined ? getMonsterMaxHp(monster) : '-';
                const dmg = monster.currentDamage || 0;
                ov.textContent = `HP:${hp} D:${dmg}`;
            }
        }
    });

    // 相手フィールドは同期状態を表示専用で描画する
    document.querySelectorAll('.field-area.opponent .field-cell').forEach(cell => {
        const zone = cell.dataset.zone;
        if (zone === 'counter') {
            const counterCard = gameState.players[0].field.counter;
            const img = cell.querySelector('img');
            if (img) img.style.display = counterCard ? 'block' : 'none';
            return;
        }
        if (zone !== 'battle' && zone !== 'reserve') return;

        const siblings = Array.from(document.querySelectorAll(`.field-area.opponent .field-cell[data-zone="${zone}"]`));
        const index = siblings.indexOf(cell);
        const monster = gameState.players[0].field[zone][index];
        cell.querySelector('img.field-monster')?.remove();

        let overlay = cell.querySelector('.field-overlay');
        let name = cell.querySelector('.field-card-name');
        if (!monster) {
            overlay?.remove();
            name?.remove();
            return;
        }

        const imageData = getCardImagePath(monster);
        const image = document.createElement('img');
        image.className = 'field-monster';
        image.src = imageData.primary;
        image.alt = monster.card.cardName || 'モンスター';
        image.onerror = () => {
            image.src = imageData.fallback;
            if (!cell.querySelector('.field-card-name')) {
                const nameElement = document.createElement('div');
                nameElement.className = 'field-card-name';
                nameElement.textContent = monster.card.cardName || '';
                cell.appendChild(nameElement);
            }
        };
        cell.insertBefore(image, cell.firstChild);

        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'field-overlay';
            cell.appendChild(overlay);
        }
        overlay.textContent = `HP:${getMonsterMaxHp(monster)} D:${monster.currentDamage || 0}`;
        if (name) name.remove();
    });

    // 相手の手札エリアの描画（枚数表示を右寄せ）
    const opponentHandZone = document.querySelector('.field-area.opponent .field-row.hand-zone');
    if (opponentHandZone) {
        opponentHandZone.innerHTML = '';
        opponentHandZone.style.justifyContent = 'flex-end'; // 右寄せ
        opponentHandZone.style.paddingRight = '1rem';
        
        const handCount = gameState.players[0].hand.length;
        if (gameState.opponentHandView) {
            const handView = document.createElement('div');
            handView.style.display = 'flex';
            handView.style.alignItems = 'center';
            handView.style.gap = '0.75rem';
            
            const cardStack = document.createElement('div');
            cardStack.style.display = 'flex';
            cardStack.style.alignItems = 'center';
            cardStack.style.gap = '-18px';
            cardStack.style.padding = '0.25rem';
            
            const visibleCount = Math.min(handCount, 7);
            for (let i = 0; i < visibleCount; i++) {
                const cardBack = document.createElement('div');
                cardBack.style.width = '36px';
                cardBack.style.height = '52px';
                cardBack.style.border = '1px solid var(--border-color)';
                cardBack.style.background = 'rgba(0,0,0,0.15)';
                cardBack.style.borderRadius = '4px';
                cardBack.style.boxShadow = '0 2px 4px rgba(0,0,0,0.15)';
                cardBack.style.flexShrink = '0';
                cardStack.appendChild(cardBack);
            }
            
            const countDisplay = document.createElement('div');
            countDisplay.style.display = 'flex';
            countDisplay.style.flexDirection = 'column';
            countDisplay.style.alignItems = 'flex-end';
            countDisplay.style.justifyContent = 'center';
            countDisplay.style.color = 'var(--text-color)';
            countDisplay.style.fontSize = '0.85rem';
            countDisplay.style.fontWeight = 'bold';
            countDisplay.textContent = `${handCount}枚`;
            
            handView.appendChild(cardStack);
            handView.appendChild(countDisplay);
            opponentHandZone.appendChild(handView);
            
            const closeBtn = document.createElement('button');
            closeBtn.className = 'action-btn';
            closeBtn.textContent = '閉じる';
            closeBtn.addEventListener('click', () => {
                gameState.opponentHandView = false;
                renderUI();
            });
            opponentHandZone.appendChild(closeBtn);
        } else {
            const countDisplay = document.createElement('div');
            countDisplay.style.display = 'flex';
            countDisplay.style.alignItems = 'center';
            countDisplay.style.gap = '0.5rem';
            countDisplay.style.color = 'var(--text-color)';
            countDisplay.style.fontSize = '0.9rem';
            countDisplay.style.fontWeight = 'bold';
            
            const label = document.createElement('span');
            label.textContent = '相手の手札:';
            countDisplay.appendChild(label);
            
            const count = document.createElement('span');
            count.textContent = `${handCount}枚`;
            count.style.color = 'var(--accent-color)';
            countDisplay.appendChild(count);
            opponentHandZone.appendChild(countDisplay);
            
            const viewBtn = document.createElement('button');
            viewBtn.className = 'action-btn';
            viewBtn.textContent = '手札を見る';
            viewBtn.addEventListener('click', () => {
                gameState.opponentHandView = true;
                gameState.logs.push({ type: 'system', message: '1Pが相手の手札を確認しました', time: Date.now() });
                renderUI();
            });
            opponentHandZone.appendChild(viewBtn);
        }

        const publicFreeZone = document.createElement('div');
        publicFreeZone.className = 'opponent-public-free';
        publicFreeZone.setAttribute('aria-label', '相手の公開フリーゾーン');
        const publicFreeLabel = document.createElement('span');
        publicFreeLabel.className = 'public-free-label';
        const freeCards = gameState.players[0].free || [];
        publicFreeLabel.textContent = gameState.operationMode === 'public'
            ? `公開フリー (${freeCards.length})`
            : `非公開カード (${freeCards.length})`;
        publicFreeZone.appendChild(publicFreeLabel);
        freeCards.forEach(card => {
            const publicCard = document.createElement('button');
            publicCard.type = 'button';
            publicCard.className = 'public-free-card';
            const image = document.createElement('img');
            const name = document.createElement('span');
            if (gameState.operationMode === 'public') {
                const imageData = getCardImagePath(card);
                image.src = imageData.primary;
                image.alt = '';
                image.onerror = () => { image.src = imageData.fallback; };
                name.textContent = card.card.cardName;
                publicCard.title = `${card.card.cardName}: ${getCardEffectText(card.card)}`;
                publicCard.setAttribute('aria-label', `${card.card.cardName}。クリックしてカード情報を表示`);
            } else {
                image.src = 'img/reverse.png';
                image.alt = '非公開カード';
                name.textContent = '非公開';
                publicCard.disabled = true;
                publicCard.setAttribute('aria-label', '非公開カード');
            }
            publicCard.append(image, name);
            if (gameState.operationMode === 'public') publicCard.addEventListener('click', () => {
                gameState.selectedCard = card;
                gameState.selectedCardSource = 'opponent-free';
                displayCardDetail(card, 'opponent-free');
                updateActionPanel('opponent-free');
            });
            publicFreeZone.appendChild(publicCard);
        });
        opponentHandZone.appendChild(publicFreeZone);
    }
}

function updateMenuButtons() {
    const coinTossBtn = document.getElementById('coinTossBtn');
    const turnEndBtn = document.getElementById('turnEndBtn');
    const mulliganEndBtn = document.getElementById('mulliganEndBtn');

    if (gameState.mulliganPhase) {
        coinTossBtn.style.display = 'block';
        turnEndBtn.style.display = 'none';
        mulliganEndBtn.style.display = 'block';
        mulliganEndBtn.disabled = gameState.players[1].mulliganReady || gameState.players[1].hand.length === 0;
    } else {
        coinTossBtn.style.display = 'block';
        turnEndBtn.style.display = 'block';
        mulliganEndBtn.style.display = 'none';
        mulliganEndBtn.disabled = false;
    }
}

function updateCounterApplyButton() {
    const applyBtn = document.getElementById('counterApplyBtn');
    const cellSelected = gameState.selectedFieldCell !== null;
    
    if (!cellSelected) {
        applyBtn.disabled = true;
        return;
    }

    const zone = gameState.selectedFieldCell < 3 ? 'battle' : 'reserve';
    const index = gameState.selectedFieldCell % 3;
    const hasMonster = gameState.players[selectedFieldPlayer].field[zone][index] !== null;
    
    applyBtn.disabled = !hasMonster;
}

function syncFieldSelection() {
    document.querySelectorAll('.field-cell').forEach(c => {
        c.classList.remove('selected');
    });

    if (gameState.selectedFieldCell == null) return;

    const mini = document.querySelector(
        `.field-grid .field-cell.mini[data-pos="${gameState.selectedFieldCell}"]`
    );
    if (mini) mini.classList.add('selected');

    const zone = gameState.selectedFieldCell < 3 ? 'battle' : 'reserve';
    const index = gameState.selectedFieldCell % 3;

    const fieldArea = selectedFieldPlayer === 0 ? '.field-area.opponent' : '.field-area:not(.opponent)';
    const fieldCells = document.querySelectorAll(`${fieldArea} .field-cell[data-zone="${zone}"]`);
    if (fieldCells[index]) fieldCells[index].classList.add('selected');

    updateCounterApplyButton();
}

function updateUIInteractivity(isMyTurn) {
    const turnEndBtn = document.getElementById('turnEndBtn');
    const counterValue = document.getElementById('counterValue');
    const counterMinus = document.getElementById('counterMinus');
    const counterPlus = document.getElementById('counterPlus');
    const counterApplyBtn = document.getElementById('counterApplyBtn');
    
    if (!isMyTurn) {
        turnEndBtn.disabled = false;
        counterValue.disabled = true;
        counterMinus.disabled = true;
        counterPlus.disabled = true;
        counterApplyBtn.disabled = true;
    } else {
        turnEndBtn.disabled = false;
        counterValue.disabled = false;
        counterMinus.disabled = false;
        counterPlus.disabled = false;
    }
}

// ===== UIイベントハンドラ =====

// リサイズ機能
let isResizing = false;
let currentResizer = null;

document.getElementById('leftResizer').addEventListener('mousedown', () => {
    isResizing = true;
    currentResizer = 'left';
});

document.getElementById('rightResizer').addEventListener('mousedown', () => {
    isResizing = true;
    currentResizer = 'right';
});

document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    if (currentResizer === 'left') {
        const leftPanel = document.getElementById('leftPanel');
        const newWidth = e.clientX;
        if (newWidth >= 200 && newWidth <= 500) {
            leftPanel.style.width = newWidth + 'px';
        }
    } else if (currentResizer === 'right') {
        const rightPanel = document.getElementById('rightPanel');
        const newWidth = window.innerWidth - e.clientX;
        if (newWidth >= 200 && newWidth <= 500) {
            rightPanel.style.width = newWidth + 'px';
            document.querySelector('.menu-toggle').style.right = `calc(${newWidth}px + 2rem)`;
            document.querySelector('.menu-panel').style.right = `calc(${newWidth}px + 2rem)`;
        }
    }
});

document.addEventListener('mouseup', () => {
    isResizing = false;
    currentResizer = null;
});

// メニュートグル
document.getElementById('menuToggle').addEventListener('click', () => {
    document.getElementById('menuPanel').classList.toggle('active');
});

// コイントス
document.getElementById('coinTossBtn').addEventListener('click', () => {
    executeAction({ type: 'COIN_TOSS' });
    document.getElementById('menuPanel').classList.remove('active');
});

// ターンエンド
document.getElementById('turnEndBtn').addEventListener('click', () => {
    executeAction({ type: 'TURN_END' });
    document.getElementById('menuPanel').classList.remove('active');
});

// 手札決定(引き直し終了)
document.getElementById('mulliganEndBtn').addEventListener('click', () => {
    executeAction({ type: 'MULLIGAN_RETURN' });
    document.getElementById('menuPanel').classList.remove('active');
});

// マナ回復
document.getElementById('manaRecoverBtn').addEventListener('click', () => {
    const amount = prompt('回復するマナの量を入力してください:', '10');
    if (amount !== null && !isNaN(amount)) {
        executeAction({ type: 'RECOVER_MANA', amount: parseInt(amount) });
    }
    document.getElementById('menuPanel').classList.remove('active');
});

document.getElementById('drawToFreeBtn').addEventListener('click', () => {
    executeAction({ type: 'DRAW_TO_FREE' });
    document.getElementById('menuPanel').classList.remove('active');
});

// デッキ読み込み
document.getElementById('loadDeckBtn').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const deckData = JSON.parse(event.target.result);
                loadDeck(deckData);
                gameState.logs.push({
                    type: 'system',
                    message: 'デッキを読み込みました',
                    time: Date.now()
                });
                renderUI();
            } catch (error) {
                alert('デッキの読み込みに失敗しました: ' + error.message);
            }
        };
        reader.readAsText(file);
    };
    input.click();
    document.getElementById('menuPanel').classList.remove('active');
});

// フィールドセル選択(場)
document.querySelectorAll('.field-area:not(.opponent) .field-cell').forEach(cell => {
    cell.addEventListener('click', () => {
        const isMyTurn = isCurrentPlayerTurn();
        const zone = cell.dataset.zone;

        if (['graveyard', 'deck', 'ex', 'counter'].includes(zone)) {
            document.querySelectorAll('.field-area:not(.opponent) .field-cell')
                .forEach(c => c.classList.remove('selected'));
            cell.classList.add('selected');

            if (zone === 'counter') {
                const counterCard = gameState.players[1].field.counter;
                if (counterCard) {
                    displayCardDetail(counterCard, 'counter');
                } else {
                    displayCardDetail(null);
                }
            } else {
                displayCardDetail(null);
            }

            updateActionPanel(zone);
            return;
        }

        if (!isMyTurn) return;

        if (!gameState.mulliganPhase) {
            document.querySelectorAll('.hand-card')
                .forEach(c => c.classList.remove('selected'));
            gameState.selectedCard = null;
            gameState.selectedCardSource = null;
            renderCards();
        }

        if (zone !== 'battle' && zone !== 'reserve') return;
        selectedFieldPlayer = 1;

        const siblings = Array.from(
            document.querySelectorAll(`.field-area:not(.opponent) .field-cell[data-zone="${zone}"]`)
        );
        const index = siblings.indexOf(cell);
        if (index === -1) return;

        const miniPos = zone === 'battle' ? index : index + 3;
        const monster = gameState.players[1].field[zone][index];

        gameState.selectedFieldCell = miniPos;
        gameState.selectedFieldPosition = {
            zone: miniPos < 3 ? 'battle' : 'reserve',
            index: miniPos % 3
        };
        gameState.selectedFieldMonster = monster;

        syncFieldSelection();

        if (monster) {
            displayCardDetail(monster, 'field');
            updateActionPanel('field');
        } else {
            displayCardDetail(null);
            updateActionPanel(zone);
        }
    });
});

// フィールドセル選択(簡略図)
document.querySelectorAll('.field-grid .field-cell').forEach(cell => {
    cell.addEventListener('click', () => {
        document.querySelectorAll('.field-grid .field-cell').forEach(c => c.classList.remove('selected'));
        cell.classList.add('selected');
        
        const pos = parseInt(cell.dataset.pos);
        gameState.selectedFieldCell = pos;
        selectedFieldPlayer = 1;
        
        const zone = pos < 3 ? 'battle' : 'reserve';
        const index = pos % 3;
        gameState.selectedFieldPosition = { zone: zone, index: index };
        const monster = gameState.players[1].field[zone][index];
        gameState.selectedFieldMonster = monster;
        
        syncFieldSelection();
        
        updateCounterApplyButton();

        if (!gameState.mulliganPhase) {
            document.querySelectorAll('.hand-card').forEach(c => c.classList.remove('selected'));
            gameState.selectedCard = null;
            gameState.selectedCardSource = null;
            renderCards();
        }

        document.querySelectorAll('.field-area .field-cell').forEach(c => c.classList.remove('selected'));
        const mainCells = Array.from(document.querySelectorAll(`.field-area:not(.opponent) .field-cell[data-zone="${zone}"]`));
        const mainCell = mainCells[index];
        if (mainCell) mainCell.classList.add('selected');
        
        if (monster) {
            displayCardDetail(monster, 'field');
            updateActionPanel('field');
        } else {
            displayCardDetail(null);
            if (gameState.selectedCard && gameState.selectedCardSource === 'hand' && !gameState.mulliganPhase) {
                updateActionPanel('hand');
            } else {
                updateActionPanel(zone);
            }
        }
    });
});



// カウンター操作
document.getElementById('counterMinus').addEventListener('click', () => {
    const input = document.getElementById('counterValue');
    input.value = parseInt(input.value || 0) - 10;
});

document.getElementById('counterPlus').addEventListener('click', () => {
    const input = document.getElementById('counterValue');
    input.value = parseInt(input.value || 0) + 10;
});

document.getElementById('roomInfoToggleBtn').addEventListener('click', event => {
    const button = event.currentTarget;
    const panel = document.getElementById('roomInfoPanel');
    const collapsed = panel.classList.toggle('collapsed');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.textContent = collapsed ? '部屋情報を表示' : '部屋情報を隠す';
});

document.getElementById('counterToggleBtn').addEventListener('click', event => {
    const button = event.currentTarget;
    const panel = document.getElementById('counterControl');
    const collapsed = panel.classList.toggle('collapsed');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.textContent = collapsed ? 'ダメージ操作を表示' : 'ダメージ操作を隠す';
});

document.getElementById('counterApplyBtn').addEventListener('click', () => {
    const value = parseInt(document.getElementById('counterValue').value || 0);
    if (gameState.selectedFieldCell !== null) {
        executeAction({
            type: 'APPLY_DAMAGE',
            cellIndex: gameState.selectedFieldCell,
            playerIndex: selectedFieldPlayer,
            value: value
        });
    }
});

document.getElementById('decreaseOpponentHpBtn').addEventListener('click', () => {
    executeAction({ type: 'CHANGE_PLAYER_HP', playerIndex: 0, amount: -1 });
});

document.getElementById('decreasePlayerHpBtn').addEventListener('click', () => {
    executeAction({ type: 'CHANGE_PLAYER_HP', playerIndex: 1, amount: -1 });
});

document.getElementById('increaseOpponentHpBtn').addEventListener('click', () => {
    executeAction({ type: 'CHANGE_PLAYER_HP', playerIndex: 0, amount: 1 });
});

document.getElementById('increasePlayerHpBtn').addEventListener('click', () => {
    executeAction({ type: 'CHANGE_PLAYER_HP', playerIndex: 1, amount: 1 });
});

document.getElementById('decreaseOpponentShieldBtn').addEventListener('click', () => {
    executeAction({ type: 'CHANGE_PLAYER_SHIELD', playerIndex: 0, amount: -1 });
});

document.getElementById('increaseOpponentShieldBtn').addEventListener('click', () => {
    executeAction({ type: 'CHANGE_PLAYER_SHIELD', playerIndex: 0, amount: 1 });
});

document.getElementById('decreasePlayerShieldBtn').addEventListener('click', () => {
    executeAction({ type: 'CHANGE_PLAYER_SHIELD', playerIndex: 1, amount: -1 });
});

document.getElementById('increasePlayerShieldBtn').addEventListener('click', () => {
    executeAction({ type: 'CHANGE_PLAYER_SHIELD', playerIndex: 1, amount: 1 });
});

// チャット送信
function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const message = input.value.trim();
    if (!message) return;

    executeAction({
        type: 'CHAT',
        message,
        playerId: gameState.players[1].id
    });
    input.value = '';
    input.focus();
}

document.getElementById('chatSendBtn').addEventListener('click', sendChatMessage);
document.getElementById('chatInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        sendChatMessage();
    }
});

document.getElementById('startGameBtn').addEventListener('click', () => {
    if (!gameState.mulliganPhase || gameState.players[1].mulliganReady) return;
    const ownershipIssues = AmarisCollection.getState().gameMode === 'trading' && loadedDeckData
        ? AmarisCollection.getDeckOwnershipIssues(loadedDeckData)
        : [];
    if (ownershipIssues.length) {
        updateGameStartButton();
        return;
    }
    if (gameState.players[1].hand.length === 0 && gameState.players[1].deck.length > 0) {
        executeAction({ type: 'INITIAL_DRAW' });
        return;
    }
    executeAction({ type: 'MULLIGAN_RETURN' });
});

document.getElementById('playModeSelect').addEventListener('change', event => {
    executeAction({ type: 'SET_PLAY_MODE', mode: event.target.value });
});

document.getElementById('operationModeSelect').addEventListener('change', event => {
    executeAction({ type: 'SET_OPERATION_MODE', mode: event.target.value });
});

document.getElementById('skillNameModeSelect').addEventListener('change', event => {
    skillNameMode = event.target.value === 'name' ? 'name' : 'number';
    localStorage.setItem('skillNameMode', skillNameMode);
    if (gameState.selectedFieldMonster) {
        displayCardDetail(gameState.selectedFieldMonster, 'field');
        updateActionPanel('field');
    } else if (gameState.selectedCard) {
        displayCardDetail(gameState.selectedCard, gameState.selectedCardSource);
        updateActionPanel(gameState.selectedCardSource);
    }
    renderUI();
});

// 独立パネルのセルクリックイベント
document.querySelectorAll('.placement-cell').forEach(cell => {
    cell.addEventListener('click', () => {
        if (cell.classList.contains('disabled')) return;
        
        document.querySelectorAll('.placement-cell').forEach(c => c.classList.remove('selected'));
        cell.classList.add('selected');
        
        document.getElementById('placementConfirmBtn').disabled = false;
    });
});

document.getElementById('placementViewToggleBtn').addEventListener('click', () => {
    placementPanelView = placementPanelView === 'self' ? 'opponent' : 'self';
    updatePlacementPanelView();
    document.querySelectorAll('.placement-cell').forEach(c => c.classList.remove('selected'));
    document.getElementById('placementConfirmBtn').disabled = true;
});

// キャンセルボタン
document.getElementById('placementCancelBtn').addEventListener('click', () => {
    hidePlacementPanel();
});

// 場に出す確定ボタン
document.getElementById('placementConfirmBtn').addEventListener('click', () => {
    const selectedCell = document.querySelector('.placement-cell.selected');
    if (!selectedCell) return;
    
    const zone = selectedCell.dataset.zone;
    const index = parseInt(selectedCell.dataset.index);
    
    if (placementPanelCardIndex === -1 && gameState.selectedFieldMonster) {
        const currentPos = gameState.selectedFieldPosition;
        const currentMonster = gameState.players[1].field[currentPos.zone][currentPos.index];
        const targetMonster = gameState.players[1].field[zone][index];
        
        if (targetMonster) {
            gameState.players[1].field[zone][index] = currentMonster;
            gameState.players[1].field[currentPos.zone][currentPos.index] = targetMonster;
            gameState.logs.push({
                type: 'system',
                message: `${currentMonster.card.cardName}と${targetMonster.card.cardName}の位置を交換しました`,
                revealCardNames: true,
                time: Date.now()
            });
        } else {
            gameState.players[1].field[zone][index] = currentMonster;
            gameState.players[1].field[currentPos.zone][currentPos.index] = null;
            gameState.logs.push({
                type: 'system',
                message: `${currentMonster.card.cardName}を移動しました`,
                revealCardNames: true,
                time: Date.now()
            });
        }
        
        gameState.selectedFieldMonster = null;
        hidePlacementPanel();
        renderUI();
        return;
    }
    
    if (placementPanelCardIndex !== null) {
        const targetPlayer = parseInt(selectedCell.dataset.player, 10);
        executeAction({
            type: 'PLACE_MONSTER',
            source: placementPanelSource || 'hand',
            index: placementPanelCardIndex,
            position: { zone: zone, index: index },
            targetPlayer: Number.isInteger(targetPlayer) ? targetPlayer : 1
        });
        
        hidePlacementPanel();
    }
});

// 画像拡大モーダルを閉じる
document.getElementById('imageModalClose').addEventListener('click', () => {
    document.getElementById('imageModal').classList.remove('active');
});

document.getElementById('imageModal').addEventListener('click', (e) => {
    if (e.target.id === 'imageModal') {
        document.getElementById('imageModal').classList.remove('active');
    }
});

// 対象選択モーダルのキャンセル
document.getElementById('targetCancelBtn').addEventListener('click', () => {
    document.getElementById('targetModal').classList.remove('active');
});

// アクションを実行
function executeAction(action) {
    if (!action) return;
    if (gameState.winner && action.type !== 'CHAT') return;
    if (!action.id) action.id = generateActionId();
    if (handledActionIds.has(action.id)) return;
    handledActionIds.add(action.id);

    const isMyTurn = isCurrentPlayerTurn();
    
    switch(action.type) {
        case 'SET_PLAY_MODE':
            gameState.playMode = action.mode === 'semi-auto' ? 'semi-auto' : 'manual';
            if (gameState.playMode === 'semi-auto' && gameState.operationMode === 'public') {
                gameState.operationMode = 'private';
                gameState.logs.push({ type: 'system', message: 'セミオートでは操作モードを非公開にしました', time: Date.now() });
            }
            gameState.logs.push({
                type: 'system',
                message: `ゲームモードを${gameState.playMode === 'semi-auto' ? 'セミオート' : 'マニュアル'}に変更しました`,
                time: Date.now()
            });
            break;

        case 'SET_OPERATION_MODE':
            gameState.operationMode = ['private', 'public', 'auto'].includes(action.mode) ? action.mode : 'private';
            gameState.logs.push({
                type: 'system',
                message: `操作モードを${{ private: '非公開', public: '公開', auto: '自動' }[gameState.operationMode]}に変更しました`,
                time: Date.now()
            });
            break;

        case 'COIN_TOSS':
            const result = Math.random() < 0.5 ? '表' : '裏';
            gameState.logs.push({
                type: '1P',
                message: `コインTOSSをしました: ${result}`,
                time: Date.now()
            });
            break;
            
        case 'CHAT':
            gameState.logs.push({
                type: 'chat',
                message: String(action.message || '').slice(0, 300),
                playerId: action.playerId || gameState.players[1].id,
                time: Date.now()
            });
            break;
            
        case 'DRAW':
            if (!drawCardForPlayer(1)) {
                gameState.winner = gameState.players[0].id;
                gameState.logs.push({ type: 'system', message: `${gameState.players[1].id}がライブラリアウトで敗北しました`, time: Date.now() });
            }
            break;

        case 'DRAW_TO_FREE': {
            const player = gameState.players[1];
            const drawnCard = player.deck.shift();
            if (drawnCard) {
                if (!player.free) player.free = [];
                player.free.push(drawnCard);
                gameState.logs.push({
                    type: 'system',
                    message: `${player.id}が山札からカードを1枚フリーゾーンへドローしました`,
                    time: Date.now()
                });
            } else {
                gameState.winner = gameState.players[0].id;
                gameState.logs.push({
                    type: 'system',
                    message: `${player.id}がライブラリアウトで敗北しました。${gameState.winner}の勝利です`,
                    time: Date.now()
                });
            }
            break;
        }
            
        case 'INITIAL_DRAW':
            for (let i = 0; i < 5; i++) {
                if (gameState.players[1].deck.length > 0) {
                    drawCardForPlayer(1);
                }
            }
            gameState.logs.push({
                type: 'system',
                message: '初期手札を5枚ドローしました',
                time: Date.now()
            });
            break;
            
        case 'MULLIGAN_RETURN':
            if (gameState.players[1].mulliganReady || gameState.players[1].hand.length === 0) break;
            const count = gameState.mulliganSelected.length;
            const returnedCards = [];
            if (count > 0) {
                gameState.mulliganSelected.sort((a, b) => b - a).forEach(index => {
                    const card = gameState.players[1].hand.splice(index, 1)[0];
                    gameState.players[1].deck.push(card);
                    returnedCards.push(card.card.cardName);
                });
                
                shuffleDeck(1);
                
                const drawnCards = [];
                for (let i = 0; i < count; i++) {
                    if (gameState.players[1].deck.length > 0) {
                        const drawnCard = drawCardForPlayer(1, false);
                        drawnCards.push(drawnCard.card.cardName);
                    }
                }
                
                const mulliganDetails = `${count}枚のカードを引き直しました（戻したカード: ${returnedCards.join(', ')}、引いたカード: ${drawnCards.join(', ')}）`;
                if (gameState.operationMode === 'public') {
                    gameState.logs.push({ type: 'system', message: `1Pが${mulliganDetails}`, time: Date.now() });
                } else {
                    gameState.privateLogs.push({ type: 'private', message: mulliganDetails, time: Date.now() });
                }
                
                gameState.logs.push({
                    type: 'system',
                    message: `1Pが${count}枚のカードを引き直しました`,
                    time: Date.now()
                });
            } else {
                gameState.logs.push({
                    type: 'system',
                    message: '1Pは引き直しを行いませんでした',
                    time: Date.now()
                });
            }
            
            gameState.players[1].mulliganReady = true;
            gameState.mulliganPhase = networkState.connected
                ? !gameState.players.every(player => player.mulliganReady)
                : false;
            gameState.mulliganSelected = [];
            break;
        
        case 'ADD_TO_HAND':
            if (action.source === 'deck' && action.index !== undefined) {
                const card = gameState.players[1].deck[action.index];
                if (card) {
                    gameState.players[1].hand.push(gameState.players[1].deck.splice(action.index, 1)[0]);
                    gameState.logs.push({ 
                        type: 'system', 
                        message: '1Pが山札からカードを手札に加えました', 
                        time: Date.now() 
                    });
                    gameState.privateLogs.push({ 
                        type: 'private', 
                        message: `山札からカードを手札に加えました: ${card.card.cardName}`, 
                        time: Date.now() 
                    });
                }
            } else if (action.source === 'graveyard' && action.index !== undefined) {
                const card = gameState.players[1].graveyard[action.index];
                if (card) {
                    gameState.players[1].hand.push(gameState.players[1].graveyard.splice(action.index, 1)[0]);
                    gameState.logs.push({ 
                        type: 'system', 
                        message: '1Pが墓地からカードを手札に加えました', 
                        time: Date.now() 
                    });
                    gameState.privateLogs.push({ 
                        type: 'private', 
                        message: `墓地からカードを手札に加えました: ${card.card.cardName}`, 
                        time: Date.now() 
                    });
                }
            } else if (action.source === 'ex' && action.index !== undefined) {
                const card = gameState.players[1].ex[action.index];
                if (card) {
                    gameState.players[1].hand.push(gameState.players[1].ex.splice(action.index, 1)[0]);
                    gameState.logs.push({ 
                        type: 'system', 
                        message: '1PがEXからカードを手札に加えました', 
                        time: Date.now() 
                    });
                    gameState.privateLogs.push({ 
                        type: 'private', 
                        message: `EXからカードを手札に加えました: ${card.card.cardName}`, 
                        time: Date.now() 
                    });
                }
            } else if (action.source === 'free' && action.index !== undefined) {
                const card = gameState.players[1].free[action.index];
                if (card) {
                    gameState.players[1].hand.push(gameState.players[1].free.splice(action.index, 1)[0]);
                    gameState.logs.push({ 
                        type: 'system', 
                        message: '1Pがフリーゾーンからカードを手札に加えました', 
                        time: Date.now() 
                    });
                    gameState.privateLogs.push({ 
                        type: 'private', 
                        message: `フリーゾーンからカードを手札に加えました: ${card.card.cardName}`, 
                        time: Date.now() 
                    });
                }
            }
            gameState.selectedCard = null;
            gameState.selectedCardSource = null;
            break;
        case 'VIEW_ZONE':
            if (action.zone === 'deck') {
                gameState.handZoneMode = 'deck';
                gameState.logs.push({ type: 'system', message: '1Pが山札を確認しました', time: Date.now() });
            } else if (action.zone === 'graveyard') {
                gameState.handZoneMode = 'graveyard';
            } else if (action.zone === 'ex') {
                gameState.handZoneMode = 'ex';
            }
            break;
        case 'RETURN_TO_DECK':
            if (action.source && action.index !== undefined) {
                let card;
                if (action.source === 'hand') {
                    card = gameState.players[1].hand.splice(action.index, 1)[0];
                } else if (action.source === 'graveyard') {
                    card = gameState.players[1].graveyard.splice(action.index, 1)[0];
                } else if (action.source === 'ex') {
                    card = gameState.players[1].ex.splice(action.index, 1)[0];
                } else if (action.source === 'free') {
                    card = gameState.players[1].free.splice(action.index, 1)[0];
                }
                
                if (card) {
                    gameState.players[1].deck.push(card);
                    shuffleDeck(1);
                    gameState.logs.push({ type: 'system', message: `1Pがカードをデッキに戻しました: ${card.card.cardName}`, time: Date.now() });
                }
            }
            gameState.selectedCard = null;
            gameState.selectedCardSource = null;
            break;
            
        case 'ADD_TO_FREE':
            if (action.source && action.index !== undefined) {
                let card;
                if (action.source === 'hand') {
                    card = gameState.players[1].hand.splice(action.index, 1)[0];
                } else if (action.source === 'graveyard') {
                    card = gameState.players[1].graveyard.splice(action.index, 1)[0];
                } else if (action.source === 'ex') {
                    card = gameState.players[1].ex.splice(action.index, 1)[0];
                } else if (action.source === 'deck') {
                    card = gameState.players[1].deck.splice(action.index, 1)[0];
                }
                
                if (card) {
                    if (!gameState.players[1].free) gameState.players[1].free = [];
                    gameState.players[1].free.push(card);
                    gameState.logs.push({ type: 'system', message: `1Pがカードをフリーゾーンに移動しました: ${card.card.cardName}`, time: Date.now() });
                }
            }
            gameState.selectedCard = null;
            gameState.selectedCardSource = null;
            break;
            
        case 'ACTIVATE_EFFECT':
            if (gameState.selectedCard) {
                if (isSemiAutoMode()) {
                    const card = gameState.selectedCard.card;
                    const result = resolveAutomaticEffectText(card.contentText, 1, { card, target: action.target, cardChoice: action.cardChoice });
                    gameState.logs.push({ type: '1P', message: `${card.cardName}の効果を発動しました${result.unresolved ? `。未処理: ${result.unresolved}` : ''}`, revealCardNames: true, time: Date.now() });
                } else {
                    gameState.logs.push({
                        type: '1P',
                        message: `${gameState.selectedCard.card.cardName}の効果を発動: ${getCardEffectText(gameState.selectedCard.card)}`,
                        revealCardNames: true,
                        time: Date.now()
                    });
                }
            }
            break;
            
        case 'SEND_TO_GRAVEYARD':
            if (action.source && action.index !== undefined) {
                let card;
                if (action.source === 'hand') {
                    card = gameState.players[1].hand.splice(action.index, 1)[0];
                } else if (action.source === 'free') {
                    card = gameState.players[1].free.splice(action.index, 1)[0];
                } else if (action.source === 'deck') {
                    card = gameState.players[1].deck.splice(action.index, 1)[0];
                }
                
                if (card) {
                    gameState.players[1].graveyard.push(card);
                    gameState.logs.push({ type: 'system', message: `1Pがカードを墓地に送りました: ${card.card.cardName}`, time: Date.now() });
                }
            }
            gameState.selectedCard = null;
            gameState.selectedCardSource = null;
            break;
            
        case 'PLACE_MONSTER':
            if (action.source && action.index !== undefined && action.position) {
                let card;
                const source = action.source;
                        if (source === 'hand') {
                    card = gameState.players[1].hand[action.index];
                } else if (source === 'deck') {
                    card = gameState.players[1].deck[action.index];
                } else if (source === 'graveyard') {
                    card = gameState.players[1].graveyard[action.index];
                } else if (source === 'ex') {
                    card = gameState.players[1].ex[action.index];
                } else if (source === 'free') {
                    card = gameState.players[1].free[action.index];
                }
                
                if (!card) break;

                const zone = action.position.zone;
                const index = action.position.index;
                const targetPlayer = action.targetPlayer !== undefined ? action.targetPlayer : 1;
                const targetCell = gameState.players[targetPlayer].field[zone][index];
                const zoneName = zone === 'battle' ? 'バトル' : '控え';

                if (card.card.monsterType === '通常' && targetCell === null) {
                    let placedCard;
                    if (source === 'hand') {
                        placedCard = gameState.players[1].hand.splice(action.index, 1)[0];
                    } else if (source === 'deck') {
                        placedCard = gameState.players[1].deck.splice(action.index, 1)[0];
                    } else if (source === 'graveyard') {
                        placedCard = gameState.players[1].graveyard.splice(action.index, 1)[0];
                    } else if (source === 'ex') {
                        placedCard = gameState.players[1].ex.splice(action.index, 1)[0];
                    } else if (source === 'free') {
                        placedCard = gameState.players[1].free.splice(action.index, 1)[0];
                    }
                    gameState.players[targetPlayer].field[zone][index] = placedCard;
                    resolveSemiAutoOnEnter(placedCard, targetPlayer);
                    gameState.logs.push({ 
                        type: 'system', 
                        message: `1Pが${zoneName}ゾーンにモンスターを出しました: ${placedCard.card.cardName}`,
                        revealCardNames: true,
                        time: Date.now()
                    });
                    gameState.selectedCard = null;
                    gameState.selectedCardSource = null;
                } else if (card.card.monsterType === '特殊進化' && targetCell !== null) {
                    let placedCard;
                    if (source === 'hand') {
                        placedCard = gameState.players[1].hand.splice(action.index, 1)[0];
                    } else if (source === 'deck') {
                        placedCard = gameState.players[1].deck.splice(action.index, 1)[0];
                    } else if (source === 'graveyard') {
                        placedCard = gameState.players[1].graveyard.splice(action.index, 1)[0];
                    } else if (source === 'ex') {
                        placedCard = gameState.players[1].ex.splice(action.index, 1)[0];
                    } else if (source === 'free') {
                        placedCard = gameState.players[1].free.splice(action.index, 1)[0];
                    }
                    const underCard = gameState.players[targetPlayer].field[zone][index];
                    gameState.players[targetPlayer].field[zone][index] = placedCard;
                    placedCard.underCard = underCard;
                    resolveSemiAutoOnEnter(placedCard, targetPlayer);
                    gameState.logs.push({ 
                        type: 'system', 
                        message: `1Pが${zoneName}ゾーンで特殊進化しました: ${underCard.card.cardName}の上に${placedCard.card.cardName}`,
                        revealCardNames: true,
                        time: Date.now()
                    });
                    gameState.selectedCard = null;
                    gameState.selectedCardSource = null;
                } else if (source === 'ex' && card.card.monsterType === '進化' && targetPlayer === 1) {
                    const evolutionSources = findEvolutionSourcePositions(1, card.card);
                    const cost = Number(card.card.magicCost || 0);
                    const replacesSource = evolutionSources?.some(position => position.zone === zone && position.index === index);
                    if (!evolutionSources || (targetCell !== null && !replacesSource) || gameState.players[1].mana < cost) {
                        gameState.logs.push({ type: 'system', message: '進化元かマナが不足しています', time: Date.now() });
                        break;
                    }
                    gameState.players[1].mana -= cost;
                    evolutionSources.sort((left, right) => left.zone.localeCompare(right.zone) || right.index - left.index).forEach(position => {
                        const sourceMonster = gameState.players[1].field[position.zone][position.index];
                        gameState.players[1].field[position.zone][position.index] = null;
                        sourceMonster.currentDamage = 0;
                        gameState.players[1].graveyard.push(sourceMonster);
                    });
                    const placedCard = gameState.players[1].ex.splice(action.index, 1)[0];
                    gameState.players[1].field[zone][index] = placedCard;
                    resolveSemiAutoOnEnter(placedCard, 1);
                    gameState.logs.push({
                        type: 'system',
                        message: `1Pが進化元を墓地へ送り、${placedCard.card.cardName}を${zoneName}ゾーンに進化召喚しました（コスト${cost}）`,
                        revealCardNames: true,
                        time: Date.now()
                    });
                    gameState.selectedCard = null;
                    gameState.selectedCardSource = null;
                } else {
                    gameState.logs.push({
                        type: 'system',
                        message: '配置できませんでした',
                        time: Date.now()
                    });
                }
            }
            break;
            
        case 'ACTIVATE_MAGIC':
            if (action.source === 'hand' && action.index !== undefined) {
                const card = gameState.players[1].hand[action.index];
                if (!card) break;
                const cost = card.card.magicCost || 0;
                
                if (gameState.players[1].mana >= cost) {
                    gameState.players[1].mana -= cost;
                    const activatedCard = gameState.players[1].hand.splice(action.index, 1)[0];
                    gameState.players[1].graveyard.push(activatedCard);
                    gameState.logs.push({ 
                        type: '1P', 
                        message: `${activatedCard.card.cardName}を発動しました(コスト: ${cost})。効果: ${getCardEffectText(activatedCard.card)}`,
                        revealCardNames: true,
                        time: Date.now()
                    });
                    if (isSemiAutoMode()) {
                        const result = resolveAutomaticEffectText(activatedCard.card.contentText, 1, { card: activatedCard.card, target: action.target, cardChoice: action.cardChoice });
                        if (result.unresolved) gameState.logs.push({ type: 'system', message: `未処理効果: ${result.unresolved}。フリーゾーン等を使って手動処理してください`, time: Date.now() });
                    }
                    gameState.selectedCard = null;
                    gameState.selectedCardSource = null;
                } else {
                    gameState.logs.push({ 
                        type: 'system', 
                        message: `マナが足りません(必要: ${cost}、所持: ${gameState.players[1].mana})`,
                        time: Date.now()
                    });
                }
            }
            break;
            
        case 'SET_COUNTER':
            if (action.source === 'hand' && action.index !== undefined) {
                const card = gameState.players[1].hand.splice(action.index, 1)[0];
                gameState.players[1].field.counter = card;
                gameState.logs.push({ 
                    type: 'system', 
                    message: '1Pがカウンターゾーンにカードをセットしました',
                    time: Date.now()
                });
                gameState.selectedCard = null;
                gameState.selectedCardSource = null;
            }
            break;
            
        case 'ACTIVATE_SUPPORTER':
            if (action.source === 'hand' && action.index !== undefined) {
                if (!gameState.usedSupporterThisTurn) {
                    const card = gameState.players[1].hand.splice(action.index, 1)[0];
                    gameState.players[1].graveyard.push(card);
                    gameState.usedSupporterThisTurn = true;
                    gameState.logs.push({ 
                        type: '1P', 
                        message: `${card.card.cardName}を発動しました。効果: ${getCardEffectText(card.card)}`,
                        revealCardNames: true,
                        time: Date.now()
                    });
                    if (isSemiAutoMode()) {
                        const result = resolveAutomaticEffectText(card.card.contentText, 1, { card: card.card, target: action.target, cardChoice: action.cardChoice });
                        if (result.unresolved) gameState.logs.push({ type: 'system', message: `未処理効果: ${result.unresolved}。フリーゾーン等を使って手動処理してください`, time: Date.now() });
                    }
                    gameState.selectedCard = null;
                    gameState.selectedCardSource = null;
                } else {
                    gameState.logs.push({ 
                        type: 'system', 
                        message: 'このターンは既にサポーターを使用しています',
                        time: Date.now()
                    });
                }
            }
            break;

        case 'TURN_END':
            if (isMyTurn && gameState.soloMode) {
                const isOpeningTurn = gameState.isFirstPlayerFirstTurn;
                expireTemporaryModifiers(1);
                expireTemporaryModifiers(0);
                gameState.turn++;
                gameState.currentPlayer = 1;
                gameState.usedSupporterThisTurn = false;
                resetAttacksForPlayer(1);
                if (isOpeningTurn) {
                    gameState.isFirstPlayerFirstTurn = false;
                } else {
                    gameState.players[1].maxMana = Math.min(10, gameState.players[1].maxMana + 1);
                    gameState.players[1].mana = gameState.players[1].maxMana;
                    executeAction({ type: 'DRAW' });
                }
                gameState.logs.push({ type: 'system', message: `ソロモード: ターン${gameState.turn}を開始しました`, time: Date.now() });
            } else if (isMyTurn) {
                expireTemporaryModifiers(1);
                gameState.currentPlayer = 0;
                gameState.usedSupporterThisTurn = false;
                gameState.logs.push({
                    type: 'system',
                    message: '1Pがターンエンドしました',
                    time: Date.now()
                });
                
                setTimeout(() => {
                    executeAction({ type: 'TURN_END' });
                }, 500);
            } else {
                // 相手のターンエンド
                expireTemporaryModifiers(0);
                gameState.turn++;
                gameState.currentPlayer = 1;
                
                if (gameState.isFirstPlayerFirstTurn) {
                    gameState.isFirstPlayerFirstTurn = false;
                } else {
                    gameState.players[1].maxMana = Math.min(10, gameState.players[1].maxMana + 1);
                    gameState.players[1].mana = gameState.players[1].maxMana;
                    
                    executeAction({ type: 'DRAW' });
                }

                resetAttacksForPlayer(1);
                
                gameState.logs.push({
                    type: 'system',
                    message: `ターン${gameState.turn}が開始しました`,
                    time: Date.now()
                });
            }
            break;

        case 'RECOVER_MANA':
                if (action.amount !== undefined) {
                    const oldMana = gameState.players[1].mana;
                    gameState.players[1].mana = Math.min(gameState.players[1].maxMana, gameState.players[1].mana + action.amount);
                    const recovered = gameState.players[1].mana - oldMana;
                    gameState.logs.push({
                        type: 'system',
                        message: `1Pがマナを${recovered}回復しました（${oldMana} → ${gameState.players[1].mana}）`,
                        time: Date.now()
                    });
                }
                break;
            
        case 'APPLY_DAMAGE':
            const zone = action.cellIndex < 3 ? 'battle' : 'reserve';
            const index = action.cellIndex % 3;
            if (dealDamageToMonster(action.playerIndex === 0 ? 0 : 1, zone, index, action.value)) {
                document.getElementById('counterValue').value = 0;
            }
            break;

        case 'CHANGE_PLAYER_HP': {
            const playerIndex = action.playerIndex;
            const amount = Number(action.amount);
            if ((playerIndex !== 0 && playerIndex !== 1) || !Number.isFinite(amount) || amount === 0) break;

            const player = gameState.players[playerIndex];
            const previousHp = player.hp;
            player.hp = Math.max(0, player.hp + amount);
            gameState.logs.push({
                type: 'system',
                message: `${player.id}のHPが${previousHp}から${player.hp}に${amount > 0 ? '増加' : '減少'}しました`,
                time: Date.now()
            });
            if (player.hp === 0 && previousHp > 0) {
                gameState.winner = gameState.players[1 - playerIndex].id;
                gameState.logs.push({ type: 'system', message: `${gameState.winner}の勝利です`, time: Date.now() });
            }
            break;
        }

        case 'CHANGE_PLAYER_SHIELD': {
            const playerIndex = action.playerIndex;
            const amount = Number(action.amount);
            if ((playerIndex !== 0 && playerIndex !== 1) || !Number.isFinite(amount) || amount === 0) break;

            const player = gameState.players[playerIndex];
            const previousShield = player.shield;
            player.shield = Math.max(0, player.shield + amount);
            const changed = player.shield - previousShield;
            let drawnCards = 0;
            gameState.logs.push({
                type: 'system',
                message: `${player.id}のシールドが${previousShield}から${player.shield}に${changed > 0 ? '増加' : '減少'}しました`,
                time: Date.now()
            });
            if (changed < 0) {
                for (let drawIndex = 0; drawIndex < -changed; drawIndex++) {
                    const drawnCard = drawCardForPlayer(playerIndex);
                    if (!drawnCard) {
                        gameState.winner = gameState.players[1 - playerIndex].id;
                        gameState.logs.push({ type: 'system', message: `${player.id}がライブラリアウトで敗北しました。${gameState.winner}の勝利です`, time: Date.now() });
                        break;
                    }
                    drawnCards++;
                }
            }
            if (drawnCards > 0) gameState.logs.push({ type: 'system', message: `${player.id}がカードを${drawnCards}枚ドローしました`, time: Date.now() });
            break;
        }

        case 'NORMAL_ATTACK': {
            const attackerPosition = action.attacker;
            const target = action.target;
            const attacker = attackerPosition && gameState.players[1].field[attackerPosition.zone]?.[attackerPosition.index];

            if (!isCurrentPlayerTurn() || !attacker || attackerPosition.zone !== 'battle' || !canMonsterAttack(attacker) || gameState.isFirstPlayerFirstTurn) break;

            if (target?.direct) {
                if (hasMonstersOnField(0) && !canDirectAttackWithMonster(attacker)) break;

                const opponent = gameState.players[0];
                if (opponent.shield > 0) {
                    opponent.shield--;
                    drawCardForPlayer(0);
                    gameState.logs.push({ type: '1P', message: `${attacker.card.cardName}が直接攻撃し、2Pのシールドを1減らしました`, revealCardNames: true, time: Date.now() });
                } else {
                    const damage = directAttackDamage(attacker);
                    opponent.hp = Math.max(0, opponent.hp - damage);
                    gameState.logs.push({ type: '1P', message: `${attacker.card.cardName}が直接攻撃し、2Pに${damage}ダメージを与えました`, revealCardNames: true, time: Date.now() });
                    if (opponent.hp <= 0) {
                        gameState.winner = '1P';
                        gameState.logs.push({ type: 'system', message: '1Pの勝利です', time: Date.now() });
                    }
                }
            } else if (target?.playerIndex === 0 && target.zone === 'battle') {
                const defender = gameState.players[0].field.battle[target.index];
                if (!defender) break;
                const damage = getMonsterAttack(attacker) + attributeDamageBonus(attacker.card, defender.card);
                dealDamageToMonster(0, 'battle', target.index, damage);
                gameState.logs.push({ type: '1P', message: `${attacker.card.cardName}が通常攻撃しました`, revealCardNames: true, time: Date.now() });
            } else {
                break;
            }

            recordMonsterAttack(attacker);
            break;
        }

        case 'ACTIVATE_ATTACK_SKILL': {
            const position = action.attacker;
            const attacker = position && gameState.players[1].field[position.zone]?.[position.index];
            const skill = attacker?.card.skills?.[action.skillIndex];
            const stats = parseAttackSkill(skill);
            const target = action.target;
            if (!isCurrentPlayerTurn() || gameState.playMode !== 'semi-auto' || !stats || !attacker
                || position.zone !== 'battle' || !canMonsterAttack(attacker) || gameState.isFirstPlayerFirstTurn
                || gameState.players[1].mana < stats.cost) break;

            const skillAllowsDirect = /直接攻撃ができる|直接攻撃できる/.test(skill?.text || '');
            if (!stats.effectOnly && target?.direct && hasMonstersOnField(0) && !skillAllowsDirect) break;
            if (!stats.effectOnly && !target?.direct && !gameState.players[target.playerIndex]?.field[target.zone]?.[target.index]) break;

            gameState.players[1].mana -= stats.cost;
            let damageDealt = 0;
            if (!stats.effectOnly && target?.direct) {
                const opponent = gameState.players[0];
                if (opponent.shield > 0) {
                    opponent.shield--;
                    drawCardForPlayer(0);
                } else {
                    damageDealt = directAttackDamage(attacker);
                    opponent.hp = Math.max(0, opponent.hp - damageDealt);
                    if (opponent.hp === 0) gameState.winner = gameState.players[1].id;
                }
            } else if (!stats.effectOnly) {
                for (let hit = 0; hit < stats.hits; hit++) {
                    const defender = gameState.players[target.playerIndex].field[target.zone][target.index];
                    if (!defender) break;
                    const damage = stats.damage + attributeDamageBonus(attacker.card, defender.card);
                    damageDealt += Math.min(damage, Math.max(0, getMonsterMaxHp(defender) - (defender.currentDamage || 0)));
                    dealDamageToMonster(target.playerIndex, target.zone, target.index, damage);
                    if (!gameState.players[target.playerIndex].field[target.zone][target.index]) break;
                }
            }

            attacker.hasAttacked = true;
            attacker.attacksUsed = maximumNormalAttacks(attacker);
            gameState.logs.push({
                type: '1P',
                message: stats.effectOnly
                    ? `${attacker.card.cardName}のAスキル「${skill.name}」を発動（全体効果、コスト${stats.cost}）`
                    : `${attacker.card.cardName}のAスキル「${skill.name}」を${describeAttackTarget(target)}に発動（${stats.damage}ダメージ${stats.hits > 1 ? `×${stats.hits}` : ''}、コスト${stats.cost}）`,
                revealCardNames: true,
                time: Date.now()
            });
            const effectResult = resolveAutomaticEffectText(skill.text, 1, { attacker: position, target, damage: damageDealt || stats.damage });
            if (effectResult.unresolved) gameState.logs.push({ type: 'system', message: `Aスキル「${skill.name}」の未処理効果: ${effectResult.unresolved}。手動で処理してください`, time: Date.now() });
            break;
        }
    }
    renderUI();
}

function shuffleDeck(playerIndex, zone = 'deck') {
    let targetDeck;
    if (zone === 'graveyard') {
        targetDeck = gameState.players[playerIndex].graveyard;
    } else {
        targetDeck = gameState.players[playerIndex].deck;
    }
    
    for (let i = targetDeck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [targetDeck[i], targetDeck[j]] = [targetDeck[j], targetDeck[i]];
    }
}


function initOpponentField() {
    const opponentArea = document.querySelector('.field-area.opponent');
    const rows = opponentArea.querySelectorAll('.field-row');
    
    // 1行目（こちらから見て上 = 相手の中段 = 控えゾーン）- EX、控え×3、山札（左右反転）
    rows[0].innerHTML = `
        <div class="field-cell" data-zone="ex" data-pos="1-2" data-player="0">
            <img src="img/reverse.png" alt="EXデッキ">
            <div class="field-cell-label">EX</div>
        </div>
        <div class="field-cell" data-zone="reserve" data-pos="2-2" data-player="0"></div>
        <div class="field-cell" data-zone="reserve" data-pos="3-2" data-player="0"></div>
        <div class="field-cell" data-zone="reserve" data-pos="4-2" data-player="0"></div>
        <div class="field-cell" data-zone="deck" data-pos="5-2" data-player="0">
            <img src="img/reverse.png" alt="山札">
            <div class="field-cell-label">山札</div>
        </div>
    `;
    
// 2行目（相手の中段 = 控えゾーン）- 山札、控え×3、EX（自分の中段の左右反転）
    if (rows[1] && !rows[1].classList.contains('hand-zone')) {
        rows[1].innerHTML = `
            <div class="field-cell" data-zone="deck" data-pos="5-2" data-player="0">
                <img src="img/reverse.png" alt="山札">
                <div class="field-cell-label">山札</div>
            </div>
            <div class="field-cell" data-zone="reserve" data-pos="4-2" data-player="0"></div>
            <div class="field-cell" data-zone="reserve" data-pos="3-2" data-player="0"></div>
            <div class="field-cell" data-zone="reserve" data-pos="2-2" data-player="0"></div>
            <div class="field-cell" data-zone="ex" data-pos="1-2" data-player="0">
                <img src="img/reverse.png" alt="EXデッキ">
                <div class="field-cell-label">EX</div>
            </div>
        `;
    }
    
    // 3行目（相手の上段 = バトルゾーン）- カウンター、バトル×3、墓地（自分の上段の左右反転）
    if (rows[2]) {
        rows[2].innerHTML = `
            <div class="field-cell" data-zone="counter" data-pos="5-1" data-player="0">
                <img src="img/reverse.png" alt="カウンター">
                <div class="field-cell-label">カウンター</div>
            </div>
            <div class="field-cell" data-zone="battle" data-pos="4-1" data-player="0"></div>
            <div class="field-cell" data-zone="battle" data-pos="3-1" data-player="0"></div>
            <div class="field-cell" data-zone="battle" data-pos="2-1" data-player="0"></div>
            <div class="field-cell" data-zone="graveyard" data-pos="1-1" data-player="0">
                <img src="img/reverse.png" alt="墓地">
                <div class="field-cell-label">墓地</div>
            </div>
        `;
    }
    
    // 相手の場のクリックイベント（既存のコード）
    document.querySelectorAll('.field-area.opponent .field-cell').forEach(cell => {
        cell.addEventListener('click', () => {
            const zone = cell.dataset.zone;
            const player = parseInt(cell.dataset.player);
            
            // 自分の場の選択を解除
            document.querySelectorAll('.field-area:not(.opponent) .field-cell')
                .forEach(c => c.classList.remove('selected'));
            document.querySelectorAll('.hand-card')
                .forEach(c => c.classList.remove('selected'));
            document.querySelectorAll('.field-grid .field-cell')
                .forEach(c => c.classList.remove('selected'));
            gameState.selectedCard = null;
            gameState.selectedCardSource = null;
            gameState.selectedFieldCell = null;
            gameState.selectedFieldPosition = null;
            gameState.selectedFieldMonster = null;
            selectedFieldPlayer = 1;
            
            if (['graveyard', 'deck', 'ex', 'counter'].includes(zone)) {
                document.querySelectorAll('.field-area.opponent .field-cell')
                    .forEach(c => c.classList.remove('selected'));
                cell.classList.add('selected');
                
                // 相手のカード詳細表示
                if (zone === 'graveyard' && gameState.players[0].graveyard.length > 0) {
                    displayCardDetail(gameState.players[0].graveyard[gameState.players[0].graveyard.length - 1], 'opponent-graveyard');
                } else if (zone === 'counter' && gameState.players[0].field.counter) {
                    displayCardDetail(gameState.players[0].field.counter, 'opponent-counter');
                    gameState.logs.push({ type: 'system', message: '1Pが相手のカウンターを確認しました', time: Date.now() });
                }
                
                updateActionPanel('opponent-' + zone);
                return;
            }
            
            if (zone === 'battle' || zone === 'reserve') {
                const siblings = Array.from(
                    document.querySelectorAll(`.field-area.opponent .field-cell[data-zone="${zone}"]`)
                );
                const index = siblings.indexOf(cell);
                if (index === -1) return;
                
                document.querySelectorAll('.field-area.opponent .field-cell')
                    .forEach(c => c.classList.remove('selected'));
                cell.classList.add('selected');
                
                const monster = gameState.players[0].field[zone][index];
                selectedFieldPlayer = 0;
                gameState.selectedFieldCell = zone === 'battle' ? index : index + 3;
                gameState.selectedFieldPosition = { zone, index };
                gameState.selectedFieldMonster = monster;
                syncFieldSelection();
                if (monster) {
                    displayCardDetail(monster, 'opponent-field');
                    updateActionPanel('opponent-field');
                } else {
                    displayCardDetail(null);
                    updateActionPanel('opponent-' + zone);
                }
            }
        });
    });
}


// updateActionPanel関数に相手の場の処理を追加
function updateActionPanel(source) {
    renderActionPanel(source);
    if (!isSemiAutoMode()) return;

    const manualActions = new Set([
        '墓地に送る', '墓地へ送る', 'デッキに戻す', 'フリーゾーンへ', '手札に加える',
        '移動', '確認', 'シャッフル', 'ドロー'
    ]);
    document.querySelectorAll('#actionPanel button').forEach(button => {
        const label = button.textContent.trim();
        const genericHandEffect = label === '効果発動'
            && ['hand', 'deck', 'graveyard', 'free', 'ex'].includes(source);
        if (manualActions.has(label) || genericHandEffect || button.dataset.manualOnly === 'true') button.hidden = true;
    });
}

function renderActionPanel(source) {
    const actionPanel = document.getElementById('actionPanel');
    actionPanel.innerHTML = '';
    
    const isMyTurn = isCurrentPlayerTurn();
    const isCardSelectionContext = gameState.selectedCard && gameState.selectedCardSource === source;

    // 操作後にパネルをクリアする関数
    function clearAfterAction() {
        gameState.selectedCard = null;
        gameState.selectedCardSource = null;
        gameState.selectedFieldCell = null;
        gameState.selectedFieldPosition = null;
        gameState.selectedFieldMonster = null;
        document.querySelectorAll('.field-cell').forEach(c => c.classList.remove('selected'));
        document.querySelectorAll('.hand-card').forEach(c => c.classList.remove('selected'));
        actionPanel.innerHTML = '';
    }

    // 相手の墓地
    if (source === 'opponent-graveyard') {
        const buttons = ['確認', 'シャッフル', 'ドロー'];
        buttons.forEach(label => {
            const btn = document.createElement('button');
            btn.className = 'action-btn';
            btn.textContent = label;
            
            if (label === 'ドロー') {
                btn.addEventListener('click', () => {
                    if (gameState.players[0].deck.length > 0) {
                        drawCardForPlayer(0);
                        clearAfterAction();
                        renderUI();
                    }
                });
            } else if (label === 'シャッフル') {
                btn.addEventListener('click', () => {
                    shuffleDeck(0, 'graveyard');
                    gameState.logs.push({ type: 'system', message: '2Pが墓地をシャッフルしました', time: Date.now() });
                    clearAfterAction();
                    renderUI();
                });
            } else if (label === '確認') {
                btn.addEventListener('click', () => {
                    gameState.handZoneMode = 'opponent-graveyard-view';
                    clearAfterAction();
                    renderUI();
                });
            }
            
            actionPanel.appendChild(btn);
        });
        return;
    }
    
    // 相手の山札
    if (source === 'opponent-deck') {
        const buttons = ['確認', 'シャッフル', 'ドロー'];
        buttons.forEach(label => {
            const btn = document.createElement('button');
            btn.className = 'action-btn';
            btn.textContent = label;
            
            if (label === 'ドロー') {
                btn.addEventListener('click', () => {
                    if (gameState.players[0].deck.length > 0) {
                        drawCardForPlayer(0);
                        clearAfterAction();
                        renderUI();
                    }
                });
            } else if (label === 'シャッフル') {
                btn.addEventListener('click', () => {
                    shuffleDeck(0, 'deck');
                    gameState.logs.push({ type: 'system', message: '2Pが山札をシャッフルしました', time: Date.now() });
                    clearAfterAction();
                    renderUI();
                });
            } else if (label === '確認') {
                btn.addEventListener('click', () => {
                    gameState.handZoneMode = 'opponent-deck-view';
                    gameState.logs.push({ type: 'system', message: '1Pが相手の山札を確認しました', time: Date.now() });
                    clearAfterAction();
                    renderUI();
                });
            }
            
            actionPanel.appendChild(btn);
        });
        return;
    }
    
    // 相手のEX
    if (source === 'opponent-ex') {
        const btn = document.createElement('button');
        btn.className = 'action-btn full-width';
        btn.textContent = '確認';
        btn.addEventListener('click', () => {
            gameState.handZoneMode = 'opponent-ex-view';
            gameState.logs.push({ type: 'system', message: '1Pが相手のEXを確認しました', time: Date.now() });
            clearAfterAction();
            renderUI();
        });
        actionPanel.appendChild(btn);
        return;
    }

    // 相手のフィールドモンスター
    if (source === 'opponent-field') {
        const info = document.createElement('div');
        info.className = 'action-btn full-width';
        info.style.cursor = 'default';
        info.textContent = '相手のモンスター（ダメージ/回復対象）';
        actionPanel.appendChild(info);
        return;
    }
    
    // 相手のカウンター
    if (source === 'opponent-counter') {
        const info = document.createElement('div');
        info.className = 'action-btn full-width';
        info.style.cursor = 'default';
        info.textContent = gameState.players[0].field.counter ? '相手のカウンターを確認中です' : '相手のカウンターは空です';
        actionPanel.appendChild(info);
        return;
    }

    // 自分の墓地
    if (source === 'graveyard' && !(gameState.selectedCard && gameState.selectedCardSource === 'graveyard')) {
        const buttons = ['確認', 'シャッフル'];
        buttons.forEach(label => {
            const btn = document.createElement('button');
            btn.className = 'action-btn';
            btn.textContent = label;
            
            if (label === 'シャッフル') {
                btn.addEventListener('click', () => {
                    shuffleDeck(1, 'graveyard');
                    gameState.logs.push({ type: 'system', message: '1Pが墓地をシャッフルしました', time: Date.now() });
                    clearAfterAction();
                    renderUI();
                });
            } else if (label === '確認') {
                btn.addEventListener('click', () => {
                    gameState.handZoneMode = 'graveyard';
                    clearAfterAction();
                    renderUI();
                });
            }
            
            actionPanel.appendChild(btn);
        });
        return;
    }
    
    // 自分の山札
    if (source === 'deck' && !(gameState.selectedCard && gameState.selectedCardSource === 'deck')) {
        const buttons = ['確認', 'シャッフル', 'ドロー'];
        buttons.forEach(label => {
            const btn = document.createElement('button');
            btn.className = 'action-btn';
            btn.textContent = label;
            
            if (label === 'ドロー') {
                btn.addEventListener('click', () => {
                    executeAction({ type: 'DRAW' });
                    // ドローの場合はclearAfterAction()を呼ばない
                    renderUI();
                });
            } else if (label === 'シャッフル') {
                btn.addEventListener('click', () => {
                    shuffleDeck(1, 'deck');
                    gameState.logs.push({ type: 'system', message: '1Pが山札をシャッフルしました', time: Date.now() });
                    clearAfterAction();
                    renderUI();
                });
            } else if (label === '確認') {
                btn.addEventListener('click', () => {
                    gameState.handZoneMode = 'deck';
                    gameState.logs.push({ type: 'system', message: '1Pが山札を確認しました', time: Date.now() });
                    clearAfterAction();
                    renderUI();
                });
            }
            
            actionPanel.appendChild(btn);
        });
        return;
    }
    
    // 自分のEX
    if (source === 'ex' && !(gameState.selectedCard && gameState.selectedCardSource === 'ex')) {
        const btn = document.createElement('button');
        btn.className = 'action-btn full-width';
        btn.textContent = '確認';
        btn.addEventListener('click', () => {
            gameState.handZoneMode = 'ex';
            clearAfterAction();
            renderUI();
        });
        actionPanel.appendChild(btn);
        return;
    }
    
    // 自分のカウンター
    if (source === 'counter') {
        const btn = document.createElement('button');
        btn.className = 'action-btn full-width';
        btn.textContent = 'カウンター発動';
        btn.disabled = !isMyTurn;
        btn.addEventListener('click', () => {
            if (gameState.players[1].field.counter) {
                gameState.logs.push({
                    type: '1P',
                    message: `${gameState.players[1].field.counter.card.cardName}をカウンター発動しました。効果: ${getCardEffectText(gameState.players[1].field.counter.card)}`,
                    revealCardNames: true,
                    time: Date.now()
                });
                gameState.players[1].graveyard.push(gameState.players[1].field.counter);
                gameState.players[1].field.counter = null;
                clearAfterAction();
                renderUI();
            }
        });
        actionPanel.appendChild(btn);
        return;
    }


    // 場のモンスター選択時
    if (source === 'field' && gameState.selectedFieldMonster) {
        const monster = gameState.selectedFieldMonster;
        const card = monster.card;
        const canAttack = isMyTurn
            && gameState.selectedFieldPosition?.zone === 'battle'
            && canMonsterAttack(monster)
            && !gameState.isFirstPlayerFirstTurn
            && !gameState.winner;
        
        const attackBtn = document.createElement('button');
        attackBtn.className = 'action-btn';
        attackBtn.textContent = '通常攻撃';
        attackBtn.disabled = !canAttack;
        attackBtn.addEventListener('click', () => {
            const canDirectAttack = !hasMonstersOnField(0) || canDirectAttackWithMonster(monster);
            showTargetSelection('通常攻撃', (target) => {
                executeAction({
                    type: 'NORMAL_ATTACK',
                    attacker: { ...gameState.selectedFieldPosition },
                    target
                });
                clearAfterAction();
            }, { allowReserve: false, allowDirect: canDirectAttack });
        });
        actionPanel.appendChild(attackBtn);
        
        if (card.skills && card.skills.some(s => s.type === 'A')) {
            const aSkills = card.skills.filter(s => s.type === 'A');
            aSkills.forEach(skill => {
                const skillIndex = card.skills.indexOf(skill);
                const skillStats = parseAttackSkill(skill);
                const effectText = (skill.text || '').trim();
                const autoSkillSupported = !!skillStats && (!effectText || effectText === '-' || isAutomaticEffectTextSupported(effectText, { attacker: gameState.selectedFieldPosition }));
                const canUseSemiAutoSkill = isMyTurn
                    && gameState.playMode === 'semi-auto'
                    && gameState.selectedFieldPosition?.zone === 'battle'
                    && canMonsterAttack(monster)
                    && !gameState.isFirstPlayerFirstTurn
                    && !!skillStats
                    && gameState.players[1].mana >= skillStats.cost;
                const skillBtn = document.createElement('button');
                skillBtn.className = 'action-btn';
                const displaySkillName = getSkillDisplayName(card, skill);
                skillBtn.textContent = gameState.playMode === 'semi-auto' && skillStats
                    ? `セミオート ${displaySkillName}`
                    : gameState.playMode === 'semi-auto'
                        ? `Aスキル（未対応）: ${displaySkillName}`
                        : skillNameMode === 'name' ? `Aスキル: ${displaySkillName}` : displaySkillName;
                    skillBtn.dataset.manualOnly = gameState.playMode === 'semi-auto' && !autoSkillSupported ? 'true' : 'false';
                skillBtn.disabled = gameState.playMode === 'semi-auto'
                    ? !canUseSemiAutoSkill
                    : !isMyTurn;
                skillBtn.addEventListener('click', () => {
                    if (gameState.playMode === 'semi-auto' && !skillStats) {
                        gameState.logs.push({ type: 'system', message: `「${skill.name}」はセミオート未対応です。効果: ${skill.text || '効果テキストなし'}。手動で処理してください`, time: Date.now() });
                        clearAfterAction();
                        renderUI();
                        return;
                    }

                    if (isSemiAutoMode() && skillStats?.effectOnly) {
                        executeAction({
                            type: 'ACTIVATE_ATTACK_SKILL',
                            attacker: { ...gameState.selectedFieldPosition },
                            skillIndex,
                            target: null
                        });
                        clearAfterAction();
                        return;
                    }

                    showTargetSelection(`${displaySkillName}の対象`, target => {
                        if (gameState.playMode === 'semi-auto') {
                            executeAction({
                                type: 'ACTIVATE_ATTACK_SKILL',
                                attacker: { ...gameState.selectedFieldPosition },
                                skillIndex,
                                target
                            });
                        } else {
                            gameState.logs.push({
                                type: '1P',
                                message: `${card.cardName}のAスキル「${skill.name}」を${describeAttackTarget(target)}に発動しました。効果: ${skill.text || '効果テキストなし'}`,
                                revealCardNames: true,
                                time: Date.now()
                            });
                            renderUI();
                        }
                        clearAfterAction();
                    }, {
                        allowDirect: !hasMonstersOnField(0) || /直接攻撃ができる|直接攻撃できる/.test(skill.text || ''),
                        allowReserve: /控えゾーン/.test(skill.text || '')
                    });
                });
                actionPanel.appendChild(skillBtn);
            });
        }
        
        if (card.skills && card.skills.some(s => s.type === 'P')) {
            const pSkills = card.skills.filter(s => s.type === 'P');
            pSkills.forEach(skill => {
                const skillBtn = document.createElement('button');
                skillBtn.className = 'action-btn';
                const isSupportedPassive = isAutomaticEffectTextSupported(skill.text, { attacker: gameState.selectedFieldPosition });
                const displaySkillName = getSkillDisplayName(card, skill);
                skillBtn.textContent = gameState.playMode === 'semi-auto' && !isSupportedPassive
                    ? `Pスキル（未対応）: ${displaySkillName}`
                    : skillNameMode === 'name' ? `Pスキル: ${displaySkillName}` : displaySkillName;
                skillBtn.dataset.manualOnly = gameState.playMode === 'semi-auto' && !isSupportedPassive ? 'true' : 'false';
                skillBtn.disabled = !isMyTurn;
                skillBtn.addEventListener('click', () => {
                    const resolvePassive = (target, cardChoice) => {
                    if (isSemiAutoMode()) {
                        const result = resolveAutomaticEffectText(skill.text, 1, {
                            attacker: gameState.selectedFieldPosition,
                            target,
                            cardChoice,
                            damage: Number(card.attack) || 0
                        });
                        gameState.logs.push({
                            type: 'system',
                            message: `自動: Pスキル「${skill.name}」を処理しました${result.unresolved ? `。未処理: ${result.unresolved}。手動で処理してください` : ''}`,
                            revealCardNames: true,
                            time: Date.now()
                        });
                    } else {
                        gameState.logs.push({
                            type: '1P',
                            message: `${card.cardName}のPスキル「${skill.name}」を発動しました。効果: ${skill.text || '効果テキストなし'}`,
                            revealCardNames: true,
                            time: Date.now()
                        });
                    }
                    clearAfterAction();
                    renderUI();
                    };
                    if (isSemiAutoMode() && requiresEffectChoice(skill.text)) {
                        selectAutomaticEffectTarget(skill.text, `${displaySkillName}の対象`, resolvePassive);
                    } else {
                        resolvePassive(null);
                    }
                });
                actionPanel.appendChild(skillBtn);
            });
        }
        
        const moveBtn = document.createElement('button');
        moveBtn.className = 'action-btn';
        moveBtn.textContent = '移動';
        moveBtn.disabled = !isMyTurn;
        moveBtn.addEventListener('click', () => {
            showPlacementPanel(-1, card, true);
        });
        actionPanel.appendChild(moveBtn);
        
        const toGraveyardBtn = document.createElement('button');
        toGraveyardBtn.className = 'action-btn';
        toGraveyardBtn.textContent = '墓地へ送る';
        toGraveyardBtn.disabled = !isMyTurn;
        toGraveyardBtn.addEventListener('click', () => {
            const pos = gameState.selectedFieldPosition;
            gameState.players[1].field[pos.zone][pos.index] = null;
            monster.currentDamage = 0;
            gameState.players[1].graveyard.push(monster);
            gameState.logs.push({
                type: 'system',
                message: `${card.cardName}を墓地に送りました`,
                revealCardNames: true,
                time: Date.now()
            });
            gameState.selectedFieldMonster = null;
            clearAfterAction();
            renderUI();
        });
        actionPanel.appendChild(toGraveyardBtn);
        
        const toHandBtn = document.createElement('button');
        toHandBtn.className = 'action-btn';
        toHandBtn.textContent = '手札に加える';
        toHandBtn.disabled = !isMyTurn;
        toHandBtn.addEventListener('click', () => {
            const pos = gameState.selectedFieldPosition;
            gameState.players[1].field[pos.zone][pos.index] = null;
            monster.currentDamage = 0;
            gameState.players[1].hand.push(monster);
            gameState.logs.push({
                type: 'system',
                message: `${card.cardName}を手札に加えました`,
                revealCardNames: true,
                time: Date.now()
            });
            gameState.selectedFieldMonster = null;
            clearAfterAction();
            renderUI();
        });
        actionPanel.appendChild(toHandBtn);
        
        const toFreeBtn = document.createElement('button');
        toFreeBtn.className = 'action-btn';
        toFreeBtn.textContent = 'フリーゾーンへ';
        toFreeBtn.disabled = !isMyTurn;
        toFreeBtn.addEventListener('click', () => {
            const pos = gameState.selectedFieldPosition;
            gameState.players[1].field[pos.zone][pos.index] = null;
            monster.currentDamage = 0;
            if (!gameState.players[1].free) gameState.players[1].free = [];
            gameState.players[1].free.push(monster);
            gameState.logs.push({
                type: 'system',
                message: `${card.cardName}をフリーゾーンに移動しました`,
                revealCardNames: true,
                time: Date.now()
            });
            gameState.selectedFieldMonster = null;
            clearAfterAction();
            renderUI();
        });
        actionPanel.appendChild(toFreeBtn);
        
        const toDeckBtn = document.createElement('button');
        toDeckBtn.className = 'action-btn';
        toDeckBtn.textContent = 'デッキに戻す';
        toDeckBtn.disabled = !isMyTurn;
        toDeckBtn.addEventListener('click', () => {
            const pos = gameState.selectedFieldPosition;
            gameState.players[1].field[pos.zone][pos.index] = null;
            monster.currentDamage = 0;
            gameState.players[1].deck.push(monster);
            shuffleDeck(1);
            gameState.logs.push({
                type: 'system',
                message: `${card.cardName}をデッキに戻しました`,
                revealCardNames: true,
                time: Date.now()
            });
            gameState.selectedFieldMonster = null;
            clearAfterAction();
            renderUI();
        });
        actionPanel.appendChild(toDeckBtn);
        
        const effectBtn = document.createElement('button');
        effectBtn.className = 'action-btn';
        effectBtn.textContent = '効果発動';
        effectBtn.dataset.manualOnly = gameState.playMode === 'semi-auto' && !isAutomaticEffectTextSupported(card.contentText, { attacker: gameState.selectedFieldPosition }) ? 'true' : 'false';
        effectBtn.disabled = !isMyTurn;
        effectBtn.addEventListener('click', () => {
            const activateEffect = (target, cardChoice) => {
                if (isSemiAutoMode()) {
                    const result = resolveAutomaticEffectText(card.contentText, 1, { card, target, cardChoice, attacker: gameState.selectedFieldPosition });
                    gameState.logs.push({ type: '1P', message: `${card.cardName}の効果を自動処理しました${result.unresolved ? `。未処理: ${result.unresolved}` : ''}`, revealCardNames: true, time: Date.now() });
                } else {
                    gameState.logs.push({ type: '1P', message: `${card.cardName}の効果を発動しました。効果: ${getCardEffectText(card)}`, revealCardNames: true, time: Date.now() });
                }
                clearAfterAction();
                renderUI();
            };
            if (isSemiAutoMode() && requiresEffectChoice(card.contentText)) {
                selectAutomaticEffectTarget(card.contentText, `${card.cardName}の対象`, activateEffect);
            } else {
                activateEffect(null);
            }
        });
        actionPanel.appendChild(effectBtn);
        
        return;
    }

    if (source === 'mulligan') {
        if (gameState.mulliganPhase) {
            const btn = document.createElement('button');
            btn.className = 'action-btn full-width';
            btn.textContent = gameState.playMode === 'semi-auto'
                ? `初手を確定${gameState.mulliganSelected.length ? `（${gameState.mulliganSelected.length}枚を引き直す）` : ''}`
                : `デッキに戻す (${gameState.mulliganSelected.length}枚)`;
            btn.addEventListener('click', () => {
                executeAction({ type: 'MULLIGAN_RETURN' });
                clearAfterAction();
            });
            actionPanel.appendChild(btn);
        }
    } 
    else if (source === 'hand' && gameState.selectedCard && !gameState.mulliganPhase) {
        const index = gameState.players[1].hand.indexOf(gameState.selectedCard);
        
        if (index === -1) {
            gameState.selectedCard = null;
            gameState.selectedCardSource = null;
            return;
        }
        
        const card = gameState.selectedCard.card;
        
        const graveyardBtn = document.createElement('button');
        graveyardBtn.className = 'action-btn';
        graveyardBtn.textContent = '墓地に送る';
        graveyardBtn.disabled = !isMyTurn;
        graveyardBtn.addEventListener('click', () => {
            executeAction({ type: 'SEND_TO_GRAVEYARD', source: 'hand', index: index });
            clearAfterAction();
        });
        actionPanel.appendChild(graveyardBtn);
        
        const returnBtn = document.createElement('button');
        returnBtn.className = 'action-btn';
        returnBtn.textContent = 'デッキに戻す';
        returnBtn.disabled = !isMyTurn;
        returnBtn.addEventListener('click', () => {
            executeAction({ type: 'RETURN_TO_DECK', source: 'hand', index: index });
            clearAfterAction();
        });
        actionPanel.appendChild(returnBtn);
        
        const freeBtn = document.createElement('button');
        freeBtn.className = 'action-btn';
        freeBtn.textContent = 'フリーゾーンへ';
        freeBtn.disabled = !isMyTurn;
        freeBtn.addEventListener('click', () => {
            executeAction({ type: 'ADD_TO_FREE', source: 'hand', index: index });
            clearAfterAction();
        });
        actionPanel.appendChild(freeBtn);
        
        const effectBtn = document.createElement('button');
        effectBtn.className = 'action-btn';
        effectBtn.textContent = '効果発動';
        effectBtn.disabled = !isMyTurn;
        effectBtn.addEventListener('click', () => {
            const activateEffect = (target, cardChoice) => {
                executeAction({ type: 'ACTIVATE_EFFECT', target, cardChoice });
                clearAfterAction();
            };
            if (isSemiAutoMode() && requiresEffectChoice(card.contentText)) {
                selectAutomaticEffectTarget(card.contentText, `${card.cardName}の対象`, activateEffect);
            } else {
                activateEffect(null);
            }
        });
        actionPanel.appendChild(effectBtn);
        
        if (card.cardBase === 'monster') {
            if (card.monsterType === '通常' || card.monsterType === '特殊進化') {
                const placeBtn = document.createElement('button');
                placeBtn.className = 'action-btn';
                placeBtn.textContent = card.monsterType === '通常' ? '場に出す' : '場に出す(特殊進化)';
                placeBtn.disabled = !isMyTurn;
                placeBtn.addEventListener('click', () => {
                    showPlacementPanel(index, card);
                });
                actionPanel.appendChild(placeBtn);
                
                const info = document.createElement('div');
                info.style.fontSize = '0.8rem';
                info.style.color = 'var(--text-muted)';
                info.style.marginTop = '0.5rem';
                info.style.gridColumn = 'span 2';
                info.textContent = card.monsterType === '通常' 
                    ? '空いているセルに配置できます' 
                    : 'モンスターがいるセルに特殊進化できます';
                actionPanel.appendChild(info);
            }
        } else if (card.cardBase === 'magic') {
            const activateBtn = document.createElement('button');
            activateBtn.className = 'action-btn';
            const cost = card.magicCost || 0;
            activateBtn.textContent = `発動(コスト: ${cost})`;
            activateBtn.dataset.manualOnly = isSemiAutoMode() && !isAutomaticEffectTextSupported(card.contentText) ? 'true' : 'false';
            activateBtn.disabled = !isMyTurn || gameState.players[1].mana < cost;
            activateBtn.addEventListener('click', () => {
                const activateMagic = (target, cardChoice) => {
                    executeAction({ type: 'ACTIVATE_MAGIC', source: 'hand', index, target, cardChoice });
                    clearAfterAction();
                };
                if (isSemiAutoMode() && requiresEffectChoice(card.contentText)) {
                    selectAutomaticEffectTarget(card.contentText, `${card.cardName}の対象`, activateMagic);
                } else {
                    activateMagic(null);
                }
            });
            actionPanel.appendChild(activateBtn);
            
            const setCounterBtn = document.createElement('button');
            setCounterBtn.className = 'action-btn';
            setCounterBtn.textContent = 'カウンターにセット';
            setCounterBtn.dataset.manualOnly = isSemiAutoMode() ? 'true' : 'false';
            setCounterBtn.disabled = !isMyTurn || gameState.players[1].field.counter !== null;
            setCounterBtn.addEventListener('click', () => {
                executeAction({ type: 'SET_COUNTER', source: 'hand', index: index });
                clearAfterAction();
            });
            actionPanel.appendChild(setCounterBtn);
        } else if (card.cardBase === 'supporter') {
            const activateBtn = document.createElement('button');
            activateBtn.className = 'action-btn';
            activateBtn.textContent = '発動';
            activateBtn.dataset.manualOnly = isSemiAutoMode() && !isAutomaticEffectTextSupported(card.contentText) ? 'true' : 'false';
            activateBtn.disabled = !isMyTurn || gameState.usedSupporterThisTurn;
            activateBtn.addEventListener('click', () => {
                const activateSupporter = (target, cardChoice) => {
                    executeAction({ type: 'ACTIVATE_SUPPORTER', source: 'hand', index, target, cardChoice });
                    clearAfterAction();
                };
                if (isSemiAutoMode() && requiresEffectChoice(card.contentText)) {
                    selectAutomaticEffectTarget(card.contentText, `${card.cardName}の対象`, activateSupporter);
                } else {
                    activateSupporter(null);
                }
            });
            actionPanel.appendChild(activateBtn);
            
            if (gameState.usedSupporterThisTurn) {
                const info = document.createElement('div');
                info.style.fontSize = '0.8rem';
                info.style.color = 'var(--text-muted)';
                info.style.marginTop = '0.5rem';
                info.style.gridColumn = 'span 2';
                info.textContent = 'このターンは既にサポーターを使用しています';
                actionPanel.appendChild(info);
            }
        }
    }
    else if (source === 'graveyard' && !(gameState.selectedCard && gameState.selectedCardSource === 'graveyard')) {
        const buttons = ['確認', 'シャッフル'];
        buttons.forEach(label => {
            const btn = document.createElement('button');
            btn.className = 'action-btn';
            btn.textContent = label;
            
            if (label === 'シャッフル') {
                btn.addEventListener('click', () => {
                    executeAction({ type: 'SHUFFLE', zone: 'graveyard' });
                    clearAfterAction();
                });
            } else if (label === '確認') {
                btn.addEventListener('click', () => {
                    executeAction({ type: 'VIEW_ZONE', zone: 'graveyard' });
                    clearAfterAction();
                });
            }
            
            actionPanel.appendChild(btn);
        });
    } else if (source === 'deck' && !(gameState.selectedCard && gameState.selectedCardSource === 'deck')) {
        const buttons = ['確認', 'シャッフル', 'ドロー'];
        buttons.forEach(label => {
            const btn = document.createElement('button');
            btn.className = 'action-btn';
            btn.textContent = label;
            
            if (label === 'ドロー') {
                btn.addEventListener('click', () => {
                    executeAction({ type: 'DRAW' });
                    clearAfterAction();
                });
            } else if (label === 'シャッフル') {
                btn.addEventListener('click', () => {
                    executeAction({ type: 'SHUFFLE', zone: 'deck' });
                    clearAfterAction();
                });
            } else if (label === '確認') {
                btn.addEventListener('click', () => {
                    executeAction({ type: 'VIEW_ZONE', zone: 'deck' });
                    clearAfterAction();
                });
            }
            
            actionPanel.appendChild(btn);
        });
    } else if (source === 'ex' && !(gameState.selectedCard && gameState.selectedCardSource === 'ex')) {
        const btn = document.createElement('button');
        btn.className = 'action-btn full-width';
        btn.textContent = '確認';
        btn.addEventListener('click', () => {
            executeAction({ type: 'VIEW_ZONE', zone: 'ex' });
            clearAfterAction();
        });
        actionPanel.appendChild(btn);
    } else if (source === 'counter') {
        const btn = document.createElement('button');
        btn.className = 'action-btn full-width';
        btn.textContent = 'カウンター発動';
        btn.disabled = !isMyTurn;
        btn.addEventListener('click', () => {
            if (gameState.players[1].field.counter) {
                gameState.logs.push({
                    type: '1P',
                    message: `${gameState.players[1].field.counter.card.cardName}をカウンター発動しました。効果: ${getCardEffectText(gameState.players[1].field.counter.card)}`,
                    time: Date.now()
                });
                gameState.players[1].graveyard.push(gameState.players[1].field.counter);
                gameState.players[1].field.counter = null;
                clearAfterAction();
                renderUI();
            }
        });
        actionPanel.appendChild(btn);
    }
    
    if (gameState.selectedCard && ['deck', 'graveyard', 'ex', 'free'].includes(source)) {
        const sourceKey = source === 'deck' ? 'deck' : source === 'graveyard' ? 'graveyard' : source === 'ex' ? 'ex' : 'free';
        const selectedCardAtBuild = gameState.selectedCard;
        const index = gameState.players[1][sourceKey].indexOf(selectedCardAtBuild);
        
        if (index !== -1) {
            const addHandBtn = document.createElement('button');
            addHandBtn.className = 'action-btn';
            addHandBtn.textContent = '手札に加える';
            addHandBtn.disabled = !isMyTurn;
            addHandBtn.addEventListener('click', () => {
                const currentIndex = gameState.players[1][sourceKey].indexOf(selectedCardAtBuild);
                if (currentIndex === -1) {
                    clearAfterAction();
                    renderUI();
                    return;
                }
                executeAction({ type: 'ADD_TO_HAND', source: source, index: currentIndex });
                clearAfterAction();
                renderUI();
            });
            actionPanel.appendChild(addHandBtn);

            if (source === 'deck') {
                const graveyardBtn = document.createElement('button');
                graveyardBtn.className = 'action-btn';
                graveyardBtn.textContent = '墓地へ送る';
                graveyardBtn.disabled = !isMyTurn;
                graveyardBtn.addEventListener('click', () => {
                    const currentIndex = gameState.players[1].deck.indexOf(gameState.selectedCard);
                    if (currentIndex === -1) {
                        clearAfterAction();
                        renderUI();
                        return;
                    }
                    executeAction({ type: 'SEND_TO_GRAVEYARD', source: 'deck', index: currentIndex });
                    clearAfterAction();
                    renderUI();
                });
                actionPanel.appendChild(graveyardBtn);
            }

            if (source === 'free') {
                const graveyardBtn = document.createElement('button');
                graveyardBtn.className = 'action-btn';
                graveyardBtn.textContent = '墓地へ送る';
                graveyardBtn.disabled = !isMyTurn;
                graveyardBtn.addEventListener('click', () => {
                    const currentIndex = gameState.players[1].free.indexOf(selectedCardAtBuild);
                    if (currentIndex === -1) return;
                    executeAction({ type: 'SEND_TO_GRAVEYARD', source: 'free', index: currentIndex });
                    clearAfterAction();
                    renderUI();
                });
                actionPanel.appendChild(graveyardBtn);
            }
            
            if (source !== 'deck') {
                const returnBtn = document.createElement('button');
                returnBtn.className = 'action-btn';
                returnBtn.textContent = 'デッキに戻す';
                returnBtn.disabled = !isMyTurn;
                returnBtn.addEventListener('click', () => {
                    const currentIndex = gameState.players[1][sourceKey].indexOf(selectedCardAtBuild);
                    if (currentIndex === -1) {
                        clearAfterAction();
                        renderUI();
                        return;
                    }
                    executeAction({ type: 'RETURN_TO_DECK', source: source, index: currentIndex });
                    clearAfterAction();
                    renderUI();
                });
                actionPanel.appendChild(returnBtn);
            }
            
            // デッキ選択時でもフリーゾーンへ移動できるように変更
            if (source !== 'free') {
                const freeBtn = document.createElement('button');
                freeBtn.className = 'action-btn';
                freeBtn.textContent = 'フリーゾーンへ';
                freeBtn.disabled = !isMyTurn;
                freeBtn.addEventListener('click', () => {
                    const currentIndex = gameState.players[1][sourceKey].indexOf(selectedCardAtBuild);
                    if (currentIndex === -1) {
                        clearAfterAction();
                        renderUI();
                        return;
                    }
                    executeAction({ type: 'ADD_TO_FREE', source: source, index: currentIndex });
                    clearAfterAction();
                    renderUI();
                });
                actionPanel.appendChild(freeBtn);
            }
            
            const effectBtn = document.createElement('button');
            effectBtn.className = 'action-btn';
            effectBtn.textContent = '効果発動';
            effectBtn.disabled = !isMyTurn;
            effectBtn.addEventListener('click', () => {
                executeAction({ type: 'ACTIVATE_EFFECT' });
                clearAfterAction();
            });
            actionPanel.appendChild(effectBtn);
            
            if (gameState.selectedCard.card.cardBase === 'monster' || gameState.selectedCard.card.cardBase === 'ex') {
                const placeBtn = document.createElement('button');
                placeBtn.className = 'action-btn';
                const cardType = gameState.selectedCard.card.monsterType;
                placeBtn.textContent = gameState.selectedCardSource === 'ex' && cardType === '進化' ? '進化召喚' : '場に出す';
                const canAutoPlace = cardType === '通常' || cardType === '特殊進化'
                    || (gameState.selectedCardSource === 'ex' && cardType === '進化');
                placeBtn.dataset.manualOnly = isSemiAutoMode() && !canAutoPlace ? 'true' : 'false';
                placeBtn.disabled = !isMyTurn;
                placeBtn.addEventListener('click', () => {
                    showPlacementPanel(index, gameState.selectedCard.card, false, source);
                });
                actionPanel.appendChild(placeBtn);
            }
            return;
        }
    }
}

// デッキを読み込む関数
function loadDeck(deckData) {
    const ownershipIssues = AmarisCollection.getState().gameMode === 'trading'
        ? AmarisCollection.getDeckOwnershipIssues(deckData)
        : [];
    if (ownershipIssues.length) {
        loadedDeckData = null;
        gameState.logs.push({
            type: 'system',
            message: `トレードモードの所持数超過によりデッキを読み込めません: ${ownershipIssues.map(issue => `${issue.cardName} ${issue.count}/${issue.limit}`).join('、')}`,
            time: Date.now()
        });
        return false;
    }
    loadedDeckData = deckData;
    gameState.players[1].deck = [];
    gameState.players[1].ex = [];
    gameState.players[1].hand = [];
    gameState.players[1].graveyard = [];
    gameState.players[1].free = [];

    const addCardToZone = (zoneArray, item) => {
        const card = resolveDeckCard(item);
        if (!card) {
            console.warn('カードが見つかりませんでした:', item);
            return;
        }
        zoneArray.push({ card, currentDamage: 0 });
    };

    if (deckData.main) {
        deckData.main.forEach(item => {
            for (let i = 0; i < (item.count || 0); i++) {
                addCardToZone(gameState.players[1].deck, item);
            }
        });
    }

    if (deckData.ex) {
        deckData.ex.forEach(item => {
            for (let i = 0; i < (item.count || 0); i++) {
                addCardToZone(gameState.players[1].ex, item);
            }
        });
    }

    shuffleDeck(1);

    gameState.mulliganPhase = true;
    gameState.mulliganSelected = [];
    gameState.players[1].mulliganReady = false;
    executeAction({ type: 'INITIAL_DRAW' });
    updateGameStartButton();
}



// 初期化
const savedDeckData = localStorage.getItem('battleDeck');
initializeCardDatabase().then(() => {
    if (savedDeckData) {
        try {
            const deck = JSON.parse(savedDeckData);
            loadDeck(deck);
        } catch (error) {
            console.error('デッキ読み込みエラー:', error);
        }
    }
    // 相手の場を初期化
    initOpponentField();
    renderUI();

    const connectBtn = document.getElementById('onlineConnectBtn');
    if (connectBtn) {
        connectBtn.addEventListener('click', () => {
            const roomInput = document.getElementById('onlineRoomInput');
            const playerInput = document.getElementById('onlinePlayerInput');
            const roomId = roomInput?.value.trim() || '';
            const playerId = playerInput?.value.trim() || '1P';
            connectOnline(roomId, playerId);
        });
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get('online') === '1') {
        const roomId = params.get('room') || '';
        const playerId = params.get('player') || '1P';
        connectOnline(roomId, playerId);
    }
});