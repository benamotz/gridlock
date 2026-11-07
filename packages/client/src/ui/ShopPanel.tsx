import type { ShopItemId, ShopWire } from '@gridlock/shared';

interface Props {
  shop: ShopWire;
  cash: number;
  onBuy(item: ShopItemId): void;
  onClose(): void;
}

/** A short line under each item, so the menu explains itself. */
const BLURB: Record<ShopItemId, string> = {
  smg: 'Fast, short range',
  shotgun: 'Close-range punch',
  rifle: 'Long range, hits hard',
  ammo: 'Refill every gun',
  armor: 'Plate for the pouch',
  medkit: 'Heal in a fight',
  phone: 'Jobs ring in anywhere',
};

/**
 * The town shop: walk in on foot and its whole stock is here, priced, with
 * the reason any item cannot be bought right now. A tap (or click) buys;
 * the server checks everything again, so this is only ever a request.
 */
export function ShopPanel(props: Props): React.ReactElement {
  return (
    <div className="shop-panel" role="dialog" aria-label="Shop">
      <div className="shop-head">
        <span className="shop-title">Shop</span>
        <span className="shop-cash">${props.cash.toLocaleString('en-US')}</span>
        <button className="shop-close" aria-label="Close shop" onClick={props.onClose}>✕</button>
      </div>
      <div className="shop-items">
        {props.shop.items.map((item) => (
          <button
            key={item.id}
            className={`shop-item${item.blocked ? ' blocked' : ''}`}
            disabled={item.blocked !== null}
            onClick={() => props.onBuy(item.id)}
            onContextMenu={(e) => e.preventDefault()}
          >
            <span className="shop-item-name">{item.name}</span>
            <span className="shop-item-price">${item.price}</span>
            <span className="shop-item-note">{item.blocked ?? BLURB[item.id]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
