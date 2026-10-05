(function (global) {
    'use strict';

    const STORAGE_KEY = 'amariisCollection';
    const PACK_PRICE = 100;
    const CURRENCY_GRANT = 1000;
    const PACKS_PER_UR = 5;

    function readState() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            return {
                currency: Math.max(0, Number(saved.currency) || 0),
                owned: saved.owned && typeof saved.owned === 'object' ? saved.owned : {},
                pityCount: Math.max(0, Math.min(PACKS_PER_UR - 1, Number(saved.pityCount) || 0)),
                gameMode: saved.gameMode === 'trading' ? 'trading' : 'unlimited'
            };
        } catch (error) {
            console.warn('コレクションデータを読み込めませんでした。初期値を使用します。', error);
            return { currency: 0, owned: {}, pityCount: 0, gameMode: 'unlimited' };
        }
    }

    function writeState(state) {
        const normalized = {
            currency: Math.max(0, Number(state.currency) || 0),
            owned: state.owned && typeof state.owned === 'object' ? state.owned : {},
            pityCount: Math.max(0, Math.min(PACKS_PER_UR - 1, Number(state.pityCount) || 0)),
            gameMode: state.gameMode === 'trading' ? 'trading' : 'unlimited'
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
        return normalized;
    }

    function getOwned(cardId) {
        return Math.max(0, Number(readState().owned[cardId]) || 0);
    }

    function addOwned(cardId, amount = 1) {
        const state = readState();
        state.owned[cardId] = Math.max(0, Number(state.owned[cardId]) || 0) + Math.max(0, Number(amount) || 0);
        writeState(state);
        return state.owned[cardId];
    }

    function addCurrency(amount = CURRENCY_GRANT) {
        const state = readState();
        state.currency += Math.max(0, Number(amount) || 0);
        writeState(state);
        return state.currency;
    }

    function spendCurrency(amount) {
        const state = readState();
        const cost = Math.max(0, Number(amount) || 0);
        if (state.currency < cost) return false;
        state.currency -= cost;
        writeState(state);
        return true;
    }

    function setGameMode(mode) {
        const state = readState();
        state.gameMode = mode === 'trading' ? 'trading' : 'unlimited';
        writeState(state);
        return state.gameMode;
    }

    function recordPackPurchase() {
        const state = readState();
        state.pityCount++;
        const guaranteed = state.pityCount >= PACKS_PER_UR;
        if (guaranteed) state.pityCount = 0;
        writeState(state);
        return guaranteed;
    }

    function getDeckOwnershipIssues(deckData) {
        const state = readState();
        const issues = [];
        const counts = new Map();
        const zones = new Map();
        ['main', 'ex'].forEach(zone => {
            (deckData?.[zone] || []).forEach(item => {
                counts.set(item.cardName, (counts.get(item.cardName) || 0) + Math.max(0, Number(item.count) || 0));
                const cardZones = zones.get(item.cardName) || new Set();
                cardZones.add(zone);
                zones.set(item.cardName, cardZones);
            });
        });
        counts.forEach((count, cardName) => {
            const owned = Math.max(0, Number(state.owned[cardName]) || 0);
            const limit = Math.min(owned, 3);
            if (count > limit) issues.push({ cardName, count, owned, limit, zone: [...zones.get(cardName)].join('/') });
        });
        return issues;
    }

    global.AmarisCollection = Object.freeze({
        STORAGE_KEY,
        PACK_PRICE,
        CURRENCY_GRANT,
        PACKS_PER_UR,
        getState: readState,
        saveState: writeState,
        getOwned,
        addOwned,
        addCurrency,
        spendCurrency,
        setGameMode,
        recordPackPurchase,
        getDeckOwnershipIssues
    });
})(window);