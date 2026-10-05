'use strict';

function renderCurrency() {
    document.getElementById('currencyValue').textContent = AmarisCollection.getState().currency.toLocaleString('ja-JP');
}

document.getElementById('earnCurrencyBtn').addEventListener('click', () => {
    AmarisCollection.addCurrency(AmarisCollection.CURRENCY_GRANT);
    renderCurrency();
});

renderCurrency();