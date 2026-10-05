'use strict';

const RARITY_RATES = { N: 60, R: 28, SR: 9, UR: 3 };
const RARITY_ORDER = ['N', 'R', 'SR', 'UR'];
let packData;
let cardData = [];

function chooseRarity() {
    const totalWeight = Object.values(RARITY_RATES).reduce((sum, weight) => sum + weight, 0);
    let roll = Math.random() * totalWeight;
    for (const rarity of RARITY_ORDER) {
        roll -= RARITY_RATES[rarity];
        if (roll < 0) return rarity;
    }
    return RARITY_ORDER[RARITY_ORDER.length - 1];
}

function drawFromPool(pool, fallbackPool = null, forcedRarity = null) {
    const rarity = forcedRarity || chooseRarity();
    const names = (pool[rarity] || []).length ? pool[rarity] : (fallbackPool?.[rarity] || []);
    const candidates = names.map(name => cardData.find(card => card.cardName === name)).filter(Boolean);
    if (!candidates.length) return null;
    const card = candidates[Math.floor(Math.random() * candidates.length)];
    return { card, rarity };
}

function cardImage(card) {
    const cleanName = card.cardName.replace(/[\/\\:*?"<>|]/g, '');
    const fallback = { monster: 'img/monster.png', ex: 'img/ex.png', magic: 'img/magic.png', supporter: 'img/supporter.png' }[card.cardBase] || 'img/monster.png';
    return { src: `cardimg/${encodeURIComponent(cleanName)}.png`, fallback };
}

function updateWallet() {
    const state = AmarisCollection.getState();
    document.getElementById('currencyValue').textContent = state.currency.toLocaleString('ja-JP');
    document.getElementById('pityStatus').textContent = `UR確定まであと${AmarisCollection.PACKS_PER_UR - state.pityCount}パック`;
    document.querySelectorAll('.buy-btn').forEach(button => button.disabled = state.currency < AmarisCollection.PACK_PRICE);
}

function renderPacks() {
    const grid = document.getElementById('packGrid');
    grid.innerHTML = packData.packs.map(pack => `<article class="pack-item">
        <h2>${pack.name}</h2>
        <p>テーマ6枚 + 共通カード2枚 / 通常排出</p>
        <div class="pack-price">${AmarisCollection.PACK_PRICE}通貨</div>
        <button class="buy-btn" type="button" data-pack-id="${pack.id}">購入</button>
    </article>`).join('');
    grid.querySelectorAll('.buy-btn').forEach(button => button.addEventListener('click', () => buyPack(button.dataset.packId)));
    updateWallet();
}

function renderResults(pack, cards, guaranteedCard) {
    const allCards = guaranteedCard ? [...cards, guaranteedCard] : cards;
    document.getElementById('resultTitle').textContent = guaranteedCard ? `${pack.name}パック結果 + UR確定！` : `${pack.name}パック結果`;
    document.getElementById('resultCards').innerHTML = allCards.map(({ card, rarity }) => {
        const image = cardImage(card);
        return `<div class="result-card">
            <img src="${image.src}" data-fallback="${image.fallback}" alt="${card.cardName.replace(/[&<>"']/g, '')}" onerror="this.onerror=null;this.src=this.dataset.fallback;">
            <div class="result-info"><div class="result-name">${card.cardName}</div><div class="result-rarity">${rarity}</div></div>
        </div>`;
    }).join('');
    document.getElementById('packResult').hidden = false;
    document.getElementById('packResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function buyPack(packId) {
    const pack = packData.packs.find(item => item.id === packId);
    if (!pack || !AmarisCollection.spendCurrency(AmarisCollection.PACK_PRICE)) {
        updateWallet();
        return;
    }

    const result = [];
    for (let slot = 0; slot < 6; slot++) {
        const card = drawFromPool(pack.cardsByRarity, packData.commonByRarity);
        if (card) result.push(card);
    }
    for (let slot = 0; slot < 2; slot++) {
        const card = drawFromPool(packData.commonByRarity);
        if (card) result.push(card);
    }

    result.forEach(item => AmarisCollection.addOwned(item.card.cardName, 1));
    const hasPity = AmarisCollection.recordPackPurchase();
    const guaranteedCard = hasPity ? drawFromPool(pack.cardsByRarity, null, 'UR') : null;
    if (guaranteedCard) AmarisCollection.addOwned(guaranteedCard.card.cardName, 1);

    renderResults(pack, result, guaranteedCard);
    updateWallet();
}

Promise.all([fetch('packs.json', { cache: 'no-cache' }).then(response => response.json()), fetch('card.json', { cache: 'no-cache' }).then(response => response.json())])
    .then(([packs, cards]) => {
        packData = packs;
        cardData = cards;
        renderPacks();
    })
    .catch(error => {
        document.getElementById('packGrid').textContent = `パックデータを読み込めませんでした: ${error.message}`;
    });