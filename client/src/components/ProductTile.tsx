// Product display: the 190px keycap face plus an optional price block.
// When prices are provided the component is no longer purely decorative —
// aria-hidden is removed and the price line becomes part of the accessible
// content so screen readers announce the sale price to buyers.
import "./ProductTile.css";

export interface ProductTileProps {
  /** Base retail price (crossed out as a value anchor). */
  originalPrice?: number;
  /** Active flash-sale price — what the buyer pays. */
  flashSalePrice?: number;
}

export function ProductTile({ originalPrice, flashSalePrice }: ProductTileProps) {
  const hasPrices = originalPrice !== undefined || flashSalePrice !== undefined;

  return (
    <div className="product-tile-wrap">
      {/* The keycap graphic is always decorative — prices are in the sibling. */}
      <div className="product-tile" aria-hidden="true">
        <span className="product-tile__mark">K1</span>
      </div>

      {hasPrices && (
        <div className="product-tile__prices">
          {originalPrice !== undefined && (
            <s className="product-tile__original" aria-label={`Original price $${originalPrice.toFixed(2)}`}>
              ${originalPrice.toFixed(2)}
            </s>
          )}
          {flashSalePrice !== undefined && (
            <strong className="product-tile__flash" aria-label={`Flash sale price $${flashSalePrice.toFixed(2)}`}>
              ${flashSalePrice.toFixed(2)}
            </strong>
          )}
        </div>
      )}
    </div>
  );
}
