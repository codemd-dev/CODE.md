# code.md for https://github.com/medusajs/dtc-starter
Machine-generated structural truth for this repository.
Used by coding agents to understand architecture, flow, and dependencies.

Generated for medusajs/dtc-starter from direct repository evidence only. No LLM summaries, feature catalog, embeddings, vectors, train pairs, or model-layer files are used.
Only deterministic sections requested by the user are included.

## api_routes
Evidence: deterministic Python decorator parsing plus exact JavaScript/TypeScript route-call parsing from source files.
_No rows found from the available direct evidence._

## entry_points
Evidence: exact `entry_points` array from the selected callgraph artifact.
| Node | Out-degree | In-degree |
| --- | --- | --- |
| apps.storefront.check-env-variables.checkEnvVariables | 0 | 1 |
| apps.storefront.src.app.[countryCode].(checkout).layout.CheckoutLayout | 0 | 2 |
| apps.storefront.src.app.[countryCode].(main).verify-account.page.VerifyAccountPage | 0 | 2 |
| apps.storefront.src.app.layout.RootLayout | 0 | 2 |
| apps.storefront.src.lib.util.compare-addresses.compareAddresses | 0 | 1 |
| apps.storefront.src.lib.util.get-product-price.getProductPrice | 2 | 1 |
| apps.storefront.src.lib.util.medusa-error.medusaError | 0 | 1 |
| apps.storefront.src.lib.util.sort-products.sortProducts | 0 | 1 |
| apps.storefront.src.modules.account.components.transfer-request-form.index.TransferRequestForm | 0 | 1 |
| apps.storefront.src.modules.categories.templates.index.CategoryTemplate | 1 | 1 |
| apps.storefront.src.modules.checkout.components.submit-button.index.SubmitButton | 0 | 3 |
| apps.storefront.src.modules.collections.templates.index.CollectionTemplate | 0 | 1 |
| apps.storefront.src.modules.products.components.product-actions.index.ProductActions | 3 | 1 |
| apps.storefront.src.modules.products.components.product-price.index.ProductPrice | 0 | 2 |
| apps.storefront.src.modules.shipping.components.free-shipping-price-nudge.index.ShippingPriceNudge | 3 | 1 |
| apps.storefront.src.modules.store.components.pagination.index.Pagination | 1 | 1 |

## risky_functions
Evidence: callgraph in-degree count only. Higher in-degree means more callers in the extracted graph.
| Node | In-degree | Out-degree | Total degree |
| --- | --- | --- | --- |
| apps.storefront.src.lib.data.cookies.getAuthHeaders | 29 | 0 | 29 |
| apps.storefront.src.lib.data.cookies.getCacheTag | 20 | 0 | 20 |
| apps.storefront.src.lib.data.cookies.getCacheOptions | 19 | 1 | 20 |
| apps.storefront.src.lib.data.cookies.getCartId | 12 | 0 | 12 |
| module.apps.storefront.src.lib.data.cookies | 12 | 11 | 23 |
| apps.storefront.src.modules.account.components.account-info.index.AccountInfo | 6 | 0 | 6 |
| apps.storefront.src.modules.checkout.components.error-message.index.ErrorMessage | 5 | 0 | 5 |
| module.apps.storefront.src.modules.account.components.account-info.index | 5 | 2 | 7 |
| apps.storefront.src.lib.data.regions.getRegion | 4 | 1 | 5 |
| apps.storefront.src.lib.data.cart.updateCart | 3 | 3 | 6 |
| apps.storefront.src.lib.data.cookies.removeCartId | 3 | 0 | 3 |
| apps.storefront.src.lib.data.customer.completeLogin | 3 | 6 | 9 |
| apps.storefront.src.lib.util.get-product-price.getPricesForVariant | 3 | 2 | 5 |
| apps.storefront.src.modules.checkout.components.submit-button.index.SubmitButton | 3 | 0 | 3 |
| apps.storefront.src.modules.layout.components.cart-dropdown.index.open | 3 | 0 | 3 |
| module.apps.storefront.src.modules.checkout.components.error-message.index | 3 | 1 | 4 |
| apps.storefront.src.app.[countryCode].(checkout).checkout.page.Checkout | 2 | 0 | 2 |
| apps.storefront.src.app.[countryCode].(checkout).layout.CheckoutLayout | 2 | 0 | 2 |
| apps.storefront.src.app.[countryCode].(checkout).not-found.NotFound | 2 | 0 | 2 |
| apps.storefront.src.app.[countryCode].(main).account.@dashboard.addresses.page.Addresses | 2 | 0 | 2 |
| apps.storefront.src.app.[countryCode].(main).account.@dashboard.loading.Loading | 2 | 0 | 2 |
| apps.storefront.src.app.[countryCode].(main).account.@dashboard.orders.details.[id].page.OrderDetailPage | 2 | 0 | 2 |
| apps.storefront.src.app.[countryCode].(main).account.@dashboard.orders.page.Orders | 2 | 0 | 2 |
| apps.storefront.src.app.[countryCode].(main).account.@dashboard.page.OverviewTemplate | 2 | 0 | 2 |
| apps.storefront.src.app.[countryCode].(main).account.@dashboard.profile.page.Divider | 2 | 0 | 2 |
| apps.storefront.src.app.[countryCode].(main).account.@dashboard.profile.page.Profile | 2 | 1 | 3 |
| apps.storefront.src.app.[countryCode].(main).account.@login.page.Login | 2 | 0 | 2 |
| apps.storefront.src.app.[countryCode].(main).account.layout.AccountPageLayout | 2 | 0 | 2 |
| apps.storefront.src.app.[countryCode].(main).account.loading.Loading | 2 | 0 | 2 |
| apps.storefront.src.app.[countryCode].(main).cart.loading.Loading | 2 | 0 | 2 |

## top_connected_nodes
Evidence: total callgraph degree count only.
| Node | Total degree | In-degree | Out-degree |
| --- | --- | --- | --- |
| apps.storefront.src.lib.data.cookies.getAuthHeaders | 29 | 29 | 0 |
| module.apps.storefront.src.lib.data.cookies | 23 | 12 | 11 |
| apps.storefront.src.lib.data.cookies.getCacheOptions | 20 | 19 | 1 |
| apps.storefront.src.lib.data.cookies.getCacheTag | 20 | 20 | 0 |
| module.apps.storefront.src.lib.data.cart | 20 | 0 | 20 |
| module.apps.storefront.src.lib.data.customer | 13 | 0 | 13 |
| apps.storefront.src.lib.data.cookies.getCartId | 12 | 12 | 0 |
| apps.storefront.src.lib.data.customer.completeLogin | 9 | 3 | 6 |
| apps.storefront.src.lib.data.cart.getOrSetCart | 8 | 2 | 6 |
| module.apps.storefront.src.modules.account.components.account-info.index | 7 | 5 | 2 |
| module.apps.storefront.src.modules.checkout.components.payment-button.index | 7 | 1 | 6 |
| apps.storefront.src.lib.data.cart.updateCart | 6 | 3 | 3 |
| apps.storefront.src.lib.data.products.listProducts | 6 | 2 | 4 |
| apps.storefront.src.modules.account.components.account-info.index.AccountInfo | 6 | 6 | 0 |
| module.apps.storefront.src.lib.data.orders | 6 | 0 | 6 |
| module.apps.storefront.src.lib.data.regions | 6 | 2 | 4 |
| module.apps.storefront.src.lib.util.get-product-price | 6 | 0 | 6 |
| module.apps.storefront.src.modules.checkout.components.addresses.index | 6 | 0 | 6 |
| module.apps.storefront.src.modules.checkout.components.shipping-address.index | 6 | 1 | 5 |
| module.apps.storefront.src.modules.layout.components.cart-dropdown.index | 6 | 1 | 5 |
| module.apps.storefront.src.modules.products.components.product-actions.index | 6 | 0 | 6 |
| module.apps.storefront.src.modules.store.components.pagination.index | 6 | 0 | 6 |
| next.page.countryCode_main | 6 | 0 | 6 |
| next.page.countryCode_main_cart | 6 | 0 | 6 |
| apps.storefront.src.lib.data.cart.applyPromotions | 5 | 2 | 3 |
| apps.storefront.src.lib.data.cart.placeOrder | 5 | 1 | 4 |
| apps.storefront.src.lib.data.cart.retrieveCart | 5 | 2 | 3 |
| apps.storefront.src.lib.data.cart.updateRegion | 5 | 1 | 4 |
| apps.storefront.src.lib.data.customer.transferCart | 5 | 2 | 3 |
| apps.storefront.src.lib.data.locale-actions.updateLocale | 5 | 1 | 4 |

## complex_functions
Evidence: callgraph out-degree count only. Higher out-degree means the node calls more extracted targets.
| Node | Out-degree | In-degree | Total degree |
| --- | --- | --- | --- |
| module.apps.storefront.src.lib.data.cart | 20 | 0 | 20 |
| module.apps.storefront.src.lib.data.customer | 13 | 0 | 13 |
| module.apps.storefront.src.lib.data.cookies | 11 | 12 | 23 |
| apps.storefront.src.lib.data.cart.getOrSetCart | 6 | 2 | 8 |
| apps.storefront.src.lib.data.customer.completeLogin | 6 | 3 | 9 |
| module.apps.storefront.src.lib.data.orders | 6 | 0 | 6 |
| module.apps.storefront.src.lib.util.get-product-price | 6 | 0 | 6 |
| module.apps.storefront.src.modules.checkout.components.addresses.index | 6 | 0 | 6 |
| module.apps.storefront.src.modules.checkout.components.payment-button.index | 6 | 1 | 7 |
| module.apps.storefront.src.modules.products.components.product-actions.index | 6 | 0 | 6 |
| module.apps.storefront.src.modules.store.components.pagination.index | 6 | 0 | 6 |
| next.page.countryCode_main | 6 | 0 | 6 |
| next.page.countryCode_main_cart | 6 | 0 | 6 |
| module.apps.storefront.src.modules.cart.templates.index | 5 | 0 | 5 |
| module.apps.storefront.src.modules.checkout.components.discount-code.index | 5 | 0 | 5 |
| module.apps.storefront.src.modules.checkout.components.shipping-address.index | 5 | 1 | 6 |
| module.apps.storefront.src.modules.checkout.components.shipping.index | 5 | 0 | 5 |
| module.apps.storefront.src.modules.common.components.modal.index | 5 | 0 | 5 |
| module.apps.storefront.src.modules.layout.components.cart-dropdown.index | 5 | 1 | 6 |
| module.apps.storefront.src.modules.store.components.refinement-list.index | 5 | 0 | 5 |
| apps.storefront.src.lib.data.cart.placeOrder | 4 | 1 | 5 |
| apps.storefront.src.lib.data.cart.updateRegion | 4 | 1 | 5 |
| apps.storefront.src.lib.data.locale-actions.updateLocale | 4 | 1 | 5 |
| apps.storefront.src.lib.data.products.listProducts | 4 | 2 | 6 |
| apps.storefront.src.modules.cart.templates.index.CartTemplate | 4 | 1 | 5 |
| apps.storefront.src.modules.checkout.components.addresses.index.Addresses | 4 | 1 | 5 |
| apps.storefront.src.modules.checkout.components.discount-code.index.DiscountCode | 4 | 1 | 5 |
| module.apps.storefront.src.app.[countryCode].(main).products.[handle].page | 4 | 1 | 5 |
| module.apps.storefront.src.lib.data.collections | 4 | 0 | 4 |
| module.apps.storefront.src.lib.data.locale-actions | 4 | 1 | 5 |

## file_dependencies
Evidence: direct file graph edges from the file graph artifact.
| Source file | Target file | Evidence reason |
| --- | --- | --- |
| apps/storefront/src/modules/account/components/address-book/index.tsx | apps/storefront/src/modules/account/components/address-card/add-address.tsx | function call, inferred call |
| apps/storefront/src/modules/account/components/address-book/index.tsx | apps/storefront/src/modules/account/components/address-card/edit-address-modal.tsx | function call, inferred call |
| apps/storefront/src/modules/account/components/order-overview/index.tsx | apps/storefront/src/modules/account/components/order-card/index.tsx | function call, inferred call |
| apps/storefront/src/modules/account/components/profile-billing-address/index.tsx | apps/storefront/src/modules/account/components/account-info/index.tsx | function call, inferred call |
| apps/storefront/src/modules/account/components/profile-email/index.tsx | apps/storefront/src/modules/account/components/account-info/index.tsx | function call, inferred call |
| apps/storefront/src/modules/account/components/profile-name/index.tsx | apps/storefront/src/modules/account/components/account-info/index.tsx | function call, inferred call |
| apps/storefront/src/modules/account/components/profile-password/index.tsx | apps/storefront/src/modules/account/components/account-info/index.tsx | function call, inferred call |
| apps/storefront/src/modules/account/components/profile-phone/index.tsx | apps/storefront/src/modules/account/components/account-info/index.tsx | function call, inferred call |
| apps/storefront/src/modules/account/templates/account-layout.tsx | apps/storefront/src/modules/account/components/account-nav/index.tsx | function call, inferred call |
| apps/storefront/src/modules/cart/templates/index.tsx | apps/storefront/src/modules/cart/components/empty-cart-message/index.tsx | function call, inferred call |
| apps/storefront/src/modules/cart/templates/index.tsx | apps/storefront/src/modules/cart/components/sign-in-prompt/index.tsx | function call, inferred call |
| apps/storefront/src/modules/cart/templates/index.tsx | apps/storefront/src/modules/cart/templates/items.tsx | function call, inferred call |
| apps/storefront/src/modules/cart/templates/index.tsx | apps/storefront/src/modules/cart/templates/summary.tsx | function call, inferred call |
| apps/storefront/src/modules/checkout/components/addresses/index.tsx | apps/storefront/src/modules/checkout/components/billing_address/index.tsx | function call, inferred call |
| apps/storefront/src/modules/checkout/components/addresses/index.tsx | apps/storefront/src/modules/checkout/components/error-message/index.tsx | function call, inferred call |
| apps/storefront/src/modules/checkout/components/addresses/index.tsx | apps/storefront/src/modules/checkout/components/shipping-address/index.tsx | function call, inferred call |
| apps/storefront/src/modules/checkout/components/addresses/index.tsx | apps/storefront/src/modules/checkout/components/submit-button/index.tsx | function call, inferred call |
| apps/storefront/src/modules/checkout/components/discount-code/index.tsx | apps/storefront/src/modules/checkout/components/error-message/index.tsx | function call, inferred call |
| apps/storefront/src/modules/checkout/components/discount-code/index.tsx | apps/storefront/src/modules/checkout/components/submit-button/index.tsx | function call, inferred call |
| apps/storefront/src/modules/checkout/components/payment-button/index.tsx | apps/storefront/src/modules/checkout/components/error-message/index.tsx | function call, inferred call |
| apps/storefront/src/modules/checkout/components/payment-container/index.tsx | apps/storefront/src/modules/checkout/components/payment-test/index.tsx | function call, inferred call |
| apps/storefront/src/modules/checkout/components/payment-wrapper/index.tsx | apps/storefront/src/modules/checkout/components/payment-wrapper/stripe-wrapper.tsx | function call, inferred call |
| apps/storefront/src/modules/checkout/components/review/index.tsx | apps/storefront/src/modules/checkout/components/payment-button/index.tsx | function call, inferred call |
| apps/storefront/src/modules/checkout/components/shipping-address/index.tsx | apps/storefront/src/modules/checkout/components/address-select/index.tsx | function call, inferred call |
| apps/storefront/src/modules/common/components/interactive-link/index.tsx | apps/storefront/src/modules/common/components/localized-client-link/index.tsx | function call, inferred call |
| apps/storefront/src/modules/layout/components/cart-button/index.tsx | apps/storefront/src/modules/layout/components/cart-dropdown/index.tsx | function call, inferred call |
| apps/storefront/src/modules/layout/components/medusa-cta/index.tsx | apps/storefront/src/modules/common/icons/medusa.tsx | function call, inferred call |
| apps/storefront/src/modules/layout/components/medusa-cta/index.tsx | apps/storefront/src/modules/common/icons/nextjs.tsx | function call, inferred call |
| apps/storefront/src/modules/layout/components/side-menu/index.tsx | apps/storefront/src/modules/layout/components/country-select/index.tsx | function call, inferred call |
| apps/storefront/src/modules/layout/components/side-menu/index.tsx | apps/storefront/src/modules/layout/components/language-select/index.tsx | function call, inferred call |
| apps/storefront/src/modules/products/components/product-actions/index.tsx | apps/storefront/src/modules/products/components/product-actions/mobile-actions.tsx | function call, inferred call |
| apps/storefront/src/modules/products/components/product-actions/index.tsx | apps/storefront/src/modules/products/components/product-price/index.tsx | function call, inferred call |
| apps/storefront/src/modules/products/components/product-actions/mobile-actions.tsx | apps/storefront/src/modules/products/components/product-actions/option-select.tsx | function call, inferred call |
| apps/storefront/src/modules/products/components/product-preview/index.tsx | apps/storefront/src/modules/products/components/product-preview/price.tsx | function call, inferred call |
| apps/storefront/src/modules/products/components/product-preview/index.tsx | apps/storefront/src/modules/products/components/thumbnail/index.tsx | function call, inferred call |
| apps/storefront/src/modules/products/components/product-tabs/index.tsx | apps/storefront/src/modules/products/components/product-tabs/accordion.tsx | function call, inferred call |
| apps/storefront/src/modules/products/templates/index.tsx | apps/storefront/src/modules/products/templates/product-actions-wrapper/index.tsx | function call, inferred call |
| apps/storefront/src/modules/store/components/refinement-list/index.tsx | apps/storefront/src/modules/store/components/refinement-list/options-picker/index.tsx | function call, inferred call |
| apps/storefront/src/modules/store/components/refinement-list/index.tsx | apps/storefront/src/modules/store/components/refinement-list/sort-products/index.tsx | function call, inferred call |
| apps/storefront/src/modules/store/templates/index.tsx | apps/storefront/src/modules/store/templates/paginated-products.tsx | function call, inferred call |
| module/apps/backend/src/api/admin/custom | apps/backend/src/api/admin/custom/route.ts | inferred call |
| module/apps/backend/src/api/store/custom | apps/backend/src/api/store/custom/route.ts | inferred call |
| module/apps/backend/src/migration-scripts | apps/backend/src/migration-scripts/initial-data-seed.ts | inferred call |
| module/apps/storefront | apps/storefront/check-env-variables.js | inferred call |
| module/apps/storefront/src | apps/storefront/src/middleware.ts | inferred call |
| module/apps/storefront/src/app | apps/storefront/src/app/layout.tsx | inferred call |
| module/apps/storefront/src/app | apps/storefront/src/app/not-found.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(checkout) | apps/storefront/src/app/[countryCode]/(checkout)/layout.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(checkout) | apps/storefront/src/app/[countryCode]/(checkout)/not-found.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(checkout)/checkout | apps/storefront/src/app/[countryCode]/(checkout)/checkout/page.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main) | apps/storefront/src/app/[countryCode]/(main)/layout.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main) | apps/storefront/src/app/[countryCode]/(main)/not-found.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main) | apps/storefront/src/app/[countryCode]/(main)/page.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/account | apps/storefront/src/app/[countryCode]/(main)/account/layout.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/account | apps/storefront/src/app/[countryCode]/(main)/account/loading.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/account/@dashboard | apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/loading.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/account/@dashboard | apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/page.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/addresses | apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/addresses/page.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/orders | apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/orders/page.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/orders/details/[id] | apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/orders/details/[id]/page.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/profile | apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/profile/page.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/account/@login | apps/storefront/src/app/[countryCode]/(main)/account/@login/page.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/cart | apps/storefront/src/app/[countryCode]/(main)/cart/loading.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/cart | apps/storefront/src/app/[countryCode]/(main)/cart/not-found.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/cart | apps/storefront/src/app/[countryCode]/(main)/cart/page.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/categories/[///category] | apps/storefront/src/app/[countryCode]/(main)/categories/[...category]/page.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/collections/[handle] | apps/storefront/src/app/[countryCode]/(main)/collections/[handle]/page.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/order/[id]/confirmed | apps/storefront/src/app/[countryCode]/(main)/order/[id]/confirmed/loading.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/order/[id]/confirmed | apps/storefront/src/app/[countryCode]/(main)/order/[id]/confirmed/page.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/order/[id]/transfer/[token] | apps/storefront/src/app/[countryCode]/(main)/order/[id]/transfer/[token]/page.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/order/[id]/transfer/[token]/accept | apps/storefront/src/app/[countryCode]/(main)/order/[id]/transfer/[token]/accept/page.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/order/[id]/transfer/[token]/decline | apps/storefront/src/app/[countryCode]/(main)/order/[id]/transfer/[token]/decline/page.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/products/[handle] | apps/storefront/src/app/[countryCode]/(main)/products/[handle]/page.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/store | apps/storefront/src/app/[countryCode]/(main)/store/page.tsx | inferred call |
| module/apps/storefront/src/app/[countryCode]/(main)/verify-account | apps/storefront/src/app/[countryCode]/(main)/verify-account/page.tsx | inferred call |
| module/apps/storefront/src/modules/account/components/account-info | apps/storefront/src/modules/account/components/account-info/index.tsx | inferred call |
| module/apps/storefront/src/modules/account/components/account-nav | apps/storefront/src/modules/account/components/account-nav/index.tsx | inferred call |
| module/apps/storefront/src/modules/account/components/address-book | apps/storefront/src/modules/account/components/address-book/index.tsx | inferred call |
| module/apps/storefront/src/modules/account/components/address-card | apps/storefront/src/modules/account/components/address-card/add-address.tsx | inferred call |
| module/apps/storefront/src/modules/account/components/address-card | apps/storefront/src/modules/account/components/address-card/edit-address-modal.tsx | inferred call |

## core_files
Evidence: file graph degree count only.
| File | Total degree | In-degree | Out-degree |
| --- | --- | --- | --- |
| next/page | 29 | 0 | 29 |
| module/apps/storefront/src/modules/common/icons | 19 | 0 | 19 |
| apps/storefront/src/modules/account/components/account-info/index.tsx | 6 | 6 | 0 |
| apps/storefront/src/modules/cart/templates/index.tsx | 5 | 1 | 4 |
| apps/storefront/src/modules/checkout/components/addresses/index.tsx | 5 | 1 | 4 |
| apps/storefront/src/modules/checkout/components/error-message/index.tsx | 4 | 4 | 0 |
| module/apps/storefront/src/modules/cart/templates | 4 | 0 | 4 |
| apps/storefront/src/modules/account/components/address-book/index.tsx | 3 | 1 | 2 |
| apps/storefront/src/modules/checkout/components/discount-code/index.tsx | 3 | 1 | 2 |
| apps/storefront/src/modules/checkout/components/payment-button/index.tsx | 3 | 2 | 1 |
| apps/storefront/src/modules/checkout/components/shipping-address/index.tsx | 3 | 2 | 1 |
| apps/storefront/src/modules/checkout/components/submit-button/index.tsx | 3 | 3 | 0 |
| apps/storefront/src/modules/layout/components/medusa-cta/index.tsx | 3 | 1 | 2 |
| apps/storefront/src/modules/layout/components/side-menu/index.tsx | 3 | 1 | 2 |
| apps/storefront/src/modules/products/components/product-actions/index.tsx | 3 | 1 | 2 |
| apps/storefront/src/modules/products/components/product-actions/mobile-actions.tsx | 3 | 2 | 1 |
| apps/storefront/src/modules/products/components/product-preview/index.tsx | 3 | 1 | 2 |
| apps/storefront/src/modules/store/components/refinement-list/index.tsx | 3 | 1 | 2 |
| module/apps/storefront/src/app/[countryCode]/(main) | 3 | 0 | 3 |
| module/apps/storefront/src/app/[countryCode]/(main)/cart | 3 | 0 | 3 |
| module/apps/storefront/src/modules/products/components/product-actions | 3 | 0 | 3 |
| apps/storefront/src/app/[countryCode]/(checkout)/checkout/page.tsx | 2 | 2 | 0 |
| apps/storefront/src/app/[countryCode]/(checkout)/layout.tsx | 2 | 2 | 0 |
| apps/storefront/src/app/[countryCode]/(checkout)/not-found.tsx | 2 | 2 | 0 |
| apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/addresses/page.tsx | 2 | 2 | 0 |
| apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/loading.tsx | 2 | 2 | 0 |
| apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/orders/details/[id]/page.tsx | 2 | 2 | 0 |
| apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/orders/page.tsx | 2 | 2 | 0 |
| apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/page.tsx | 2 | 2 | 0 |
| apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/profile/page.tsx | 2 | 2 | 0 |

## database_writes
Evidence: actual source matches to `table/from/collection` write operations, plus caller count for the enclosing Python callgraph function when available. No name-only matching is used.
_No rows found from the available direct evidence._

## external_calls
Evidence: direct Python/JavaScript/TypeScript import detection, excluding stdlib and local top-level modules.
| Package/module | Import count | Examples |
| --- | --- | --- |
| @modules/common | 172 | apps/storefront/src/app/[countryCode]/(checkout)/layout.tsx:1, apps/storefront/src/app/[countryCode]/(checkout)/layout.tsx:2, apps/storefront/src/app/[countryCode]/(checkout)/not-found.tsx:1, apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/loading.tsx:1, apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/orders/page.tsx:6 |
| react | 85 | apps/storefront/src/app/[countryCode]/(main)/verify-account/page.tsx:2, apps/storefront/src/lib/constants.tsx:5, apps/storefront/src/lib/context/modal-context.tsx:3, apps/storefront/src/lib/hooks/use-in-view.tsx:1, apps/storefront/src/lib/hooks/use-toggle-state.tsx:1 |
| @medusajs/types | 84 | apps/storefront/src/app/[countryCode]/(main)/categories/[...category]/page.tsx:6, apps/storefront/src/app/[countryCode]/(main)/collections/[handle]/page.tsx:6, apps/storefront/src/app/[countryCode]/(main)/layout.tsx:6, apps/storefront/src/app/[countryCode]/(main)/products/[handle]/page.tsx:6, apps/storefront/src/lib/data/cart.ts:5 |
| @lib/data | 68 | apps/storefront/src/app/[countryCode]/(checkout)/checkout/page.tsx:1, apps/storefront/src/app/[countryCode]/(checkout)/checkout/page.tsx:2, apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/addresses/page.tsx:6, apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/addresses/page.tsx:7, apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/orders/details/[id]/page.tsx:1 |
| next | 64 | apps/storefront/src/app/[countryCode]/(checkout)/checkout/page.tsx:6, apps/storefront/src/app/[countryCode]/(checkout)/checkout/page.tsx:7, apps/storefront/src/app/[countryCode]/(checkout)/not-found.tsx:2, apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/addresses/page.tsx:1, apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/addresses/page.tsx:2 |
| @lib/util | 41 | apps/storefront/src/app/[countryCode]/(main)/categories/[...category]/page.tsx:9, apps/storefront/src/app/[countryCode]/(main)/collections/[handle]/page.tsx:9, apps/storefront/src/app/[countryCode]/(main)/layout.tsx:5, apps/storefront/src/app/[countryCode]/(main)/store/page.tsx:3, apps/storefront/src/app/layout.tsx:1 |
| @modules/checkout | 22 | apps/storefront/src/app/[countryCode]/(checkout)/checkout/page.tsx:3, apps/storefront/src/app/[countryCode]/(checkout)/checkout/page.tsx:4, apps/storefront/src/app/[countryCode]/(checkout)/checkout/page.tsx:5, apps/storefront/src/modules/account/components/address-card/add-address.tsx:10, apps/storefront/src/modules/account/components/address-card/add-address.tsx:11 |
| @modules/skeletons | 21 | apps/storefront/src/app/[countryCode]/(main)/cart/loading.tsx:1, apps/storefront/src/app/[countryCode]/(main)/order/[id]/confirmed/loading.tsx:1, apps/storefront/src/modules/cart/templates/items.tsx:6, apps/storefront/src/modules/cart/templates/preview.tsx:8, apps/storefront/src/modules/categories/templates/index.tsx:5 |
| @medusajs/icons | 20 | apps/storefront/src/app/not-found.tsx:1, apps/storefront/src/lib/constants.tsx:1, apps/storefront/src/modules/account/components/account-nav/index.tsx:3, apps/storefront/src/modules/account/components/address-card/add-address.tsx:3, apps/storefront/src/modules/account/components/address-card/edit-address-modal.tsx:8 |
| types | 20 | apps/storefront/src/modules/common/icons/back.tsx:3, apps/storefront/src/modules/common/icons/bancontact.tsx:3, apps/storefront/src/modules/common/icons/chevron-down.tsx:3, apps/storefront/src/modules/common/icons/chevron-up-down.tsx:3, apps/storefront/src/modules/common/icons/eye-off.tsx:3 |
| @modules/order | 18 | apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/orders/details/[id]/page.tsx:2, apps/storefront/src/app/[countryCode]/(main)/order/[id]/confirmed/page.tsx:2, apps/storefront/src/app/[countryCode]/(main)/order/[id]/transfer/[token]/accept/page.tsx:3, apps/storefront/src/app/[countryCode]/(main)/order/[id]/transfer/[token]/decline/page.tsx:3, apps/storefront/src/app/[countryCode]/(main)/order/[id]/transfer/[token]/page.tsx:2 |
| @modules/store | 16 | apps/storefront/src/app/[countryCode]/(main)/categories/[...category]/page.tsx:8, apps/storefront/src/app/[countryCode]/(main)/collections/[handle]/page.tsx:8, apps/storefront/src/app/[countryCode]/(main)/store/page.tsx:4, apps/storefront/src/app/[countryCode]/(main)/store/page.tsx:5, apps/storefront/src/lib/data/products.ts:7 |
| @modules/account | 15 | apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/addresses/page.tsx:4, apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/orders/page.tsx:3, apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/orders/page.tsx:7, apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/page.tsx:3, apps/storefront/src/app/[countryCode]/(main)/account/@dashboard/profile/page.tsx:3 |
| @modules/products | 15 | apps/storefront/src/app/[countryCode]/(main)/products/[handle]/page.tsx:5, apps/storefront/src/modules/account/components/order-card/index.tsx:4, apps/storefront/src/modules/cart/components/item/index.tsx:14, apps/storefront/src/modules/home/components/featured-products/product-rail/index.tsx:6, apps/storefront/src/modules/layout/components/cart-dropdown/index.tsx:16 |
| @lib/config | 13 | apps/storefront/src/lib/data/cart.ts:3, apps/storefront/src/lib/data/categories.ts:1, apps/storefront/src/lib/data/collections.ts:3, apps/storefront/src/lib/data/customer.ts:3, apps/storefront/src/lib/data/fulfillment.ts:3 |
| @headlessui/react | 11 | apps/storefront/src/modules/account/components/account-info/index.tsx:1, apps/storefront/src/modules/checkout/components/address-select/index.tsx:1, apps/storefront/src/modules/checkout/components/payment/index.tsx:2, apps/storefront/src/modules/checkout/components/payment-container/index.tsx:1, apps/storefront/src/modules/checkout/components/shipping/index.tsx:2 |
| @lib/hooks | 9 | apps/storefront/src/modules/account/components/account-info/index.tsx:5, apps/storefront/src/modules/account/components/address-card/add-address.tsx:8, apps/storefront/src/modules/account/components/address-card/edit-address-modal.tsx:7, apps/storefront/src/modules/checkout/components/addresses/index.tsx:3, apps/storefront/src/modules/layout/components/country-select/index.tsx:13 |
| @modules/layout | 7 | apps/storefront/src/app/[countryCode]/(checkout)/layout.tsx:3, apps/storefront/src/app/[countryCode]/(main)/layout.tsx:7, apps/storefront/src/app/[countryCode]/(main)/layout.tsx:8, apps/storefront/src/app/[countryCode]/(main)/layout.tsx:9, apps/storefront/src/modules/layout/templates/footer/index.tsx:6 |
| @medusajs/framework | 5 | apps/backend/medusa-config.ts:1, apps/backend/src/api/admin/custom/route.ts:1, apps/backend/src/api/store/custom/route.ts:1, apps/backend/src/migration-scripts/initial-data-seed.ts:1, apps/backend/src/migration-scripts/initial-data-seed.ts:7 |
| @modules/cart | 5 | apps/storefront/src/app/[countryCode]/(main)/cart/page.tsx:3, apps/storefront/src/modules/cart/components/item/index.tsx:6, apps/storefront/src/modules/cart/templates/items.tsx:5, apps/storefront/src/modules/cart/templates/preview.tsx:7, apps/storefront/src/modules/checkout/templates/checkout-summary/index.tsx:3 |
| @lib/constants | 5 | apps/storefront/src/modules/checkout/components/payment/index.tsx:3, apps/storefront/src/modules/checkout/components/payment-button/index.tsx:3, apps/storefront/src/modules/checkout/components/payment-container/index.tsx:7, apps/storefront/src/modules/checkout/components/payment-wrapper/index.tsx:7, apps/storefront/src/modules/order/components/payment-details/index.tsx:3 |
| @modules/home | 3 | apps/storefront/src/app/[countryCode]/(main)/page.tsx:3, apps/storefront/src/app/[countryCode]/(main)/page.tsx:4, apps/storefront/src/modules/home/components/featured-products/index.tsx:2 |
| lodash | 3 | apps/storefront/src/lib/util/compare-addresses.ts:1, apps/storefront/src/modules/checkout/components/shipping-address/index.tsx:5, apps/storefront/src/modules/products/components/product-actions/index.tsx:9 |
| @stripe/react-stripe-js | 3 | apps/storefront/src/modules/checkout/components/payment-button/index.tsx:7, apps/storefront/src/modules/checkout/components/payment-container/index.tsx:9, apps/storefront/src/modules/checkout/components/payment-wrapper/stripe-wrapper.tsx:4 |
| @stripe/stripe-js | 3 | apps/storefront/src/modules/checkout/components/payment-container/index.tsx:10, apps/storefront/src/modules/checkout/components/payment-wrapper/index.tsx:3, apps/storefront/src/modules/checkout/components/payment-wrapper/stripe-wrapper.tsx:3 |
| eslint | 2 | apps/backend/eslint.config.ts:1, eslint.config.ts:1 |
| @medusajs/eslint-plugin | 2 | apps/backend/eslint.config.ts:2, eslint.config.ts:2 |
| @medusajs/medusa | 2 | apps/backend/instrumentation.ts:4, apps/backend/src/migration-scripts/initial-data-seed.ts:24 |
| @medusajs/js-sdk | 2 | apps/storefront/src/lib/config.ts:2, apps/storefront/src/lib/data/customer.ts:6 |
| react-dom | 2 | apps/storefront/src/modules/account/components/account-info/index.tsx:6, apps/storefront/src/modules/checkout/components/submit-button/index.tsx:5 |
| clsx | 2 | apps/storefront/src/modules/common/components/ui/index.tsx:1, apps/storefront/src/modules/store/components/refinement-list/options-picker/index.tsx:9 |
| react-country-flag | 2 | apps/storefront/src/modules/layout/components/country-select/index.tsx:11, apps/storefront/src/modules/layout/components/language-select/index.tsx:12 |
| @radix-ui/react-accordion | 2 | apps/storefront/src/modules/products/components/product-tabs/accordion.tsx:2, apps/storefront/src/modules/store/components/refinement-list/options-picker/index.tsx:3 |
| @opentelemetry/exporter-zipkin | 1 | apps/backend/instrumentation.ts:6 |
| @medusajs/utils | 1 | apps/backend/jest.config.js:1 |
| ansi-colors | 1 | apps/storefront/check-env-variables.js:1 |
| @modules/categories | 1 | apps/storefront/src/app/[countryCode]/(main)/categories/[...category]/page.tsx:7 |
| @modules/collections | 1 | apps/storefront/src/app/[countryCode]/(main)/collections/[handle]/page.tsx:7 |
| @modules/shipping | 1 | apps/storefront/src/app/[countryCode]/(main)/layout.tsx:10 |
| styles | 1 | apps/storefront/src/app/layout.tsx:3 |

## ui_interactions
Evidence: direct HTML/UI element extraction from the HTML UI graph artifact.
_No rows found from the available direct evidence._

## known_todos
Evidence: literal TODO/FIXME-style comment extraction from repo comments.
| File | Line | Tag | Text |
| --- | --- | --- | --- |
| apps/storefront/check-env-variables.js | 6 | TODO | we need a good doc to point this to |
| apps/storefront/src/modules/cart/components/item/index.tsx | 43 | TODO | Update this to grab the actual max inventory |
| apps/storefront/src/modules/common/components/ui/index.tsx | 13 | TODO | Add Toaster component back when needed for notifications |
| apps/storefront/src/modules/account/components/profile-password/index.tsx | 7 | TODO | Re-add toast notifications when Toaster component is implemented |
| apps/storefront/src/modules/account/components/profile-password/index.tsx | 16 | TODO | Add support for password updates |
| apps/storefront/src/modules/account/components/profile-password/index.tsx | 18 | TODO | Re-add toast notification when Toaster component is implemented |
| apps/storefront/src/modules/account/components/profile-email/index.tsx | 18 | TODO | It seems we don't support updating emails now? |
| apps/storefront/src/modules/account/components/transfer-request-form/index.tsx | 6 | TODO | Re-add Toaster component when needed |
| apps/storefront/src/app/[countryCode]/(main)/account/layout.tsx | 2 | TODO | Re-add Toaster component when needed |
| apps/storefront/src/lib/data/cart.ts | 336 | TODO | Pass a POJO instead of a form entity here |

## recently_changed
Evidence: local `git log` when a `.git` directory is available; otherwise concrete GitHub commit payload from analysis if present.
| Commit | Date | Subject | Files |
| --- | --- | --- | --- |
| 91c80d9 | 2026-06-03T14:19:31Z | feat: add support for global product options | apps/backend/src/migration-scripts/initial-data-seed.ts, apps/storefront/src/app/[countryCode]/(main)/categories/[...category]/page.tsx, apps/storefront/src/app/[countryCode]/(main)/collections/[handle]/page.tsx, apps/storefront/src/app/[countryCode]/(main)/store/page.tsx, apps/storefront/src/lib/data/products.ts, apps/storefront/src/lib/util/product-option-filters.ts, apps/storefront/src/modules/categories/templates/index.tsx, apps/storefront/src/modules/collections/templates/index.tsx |
| 9738551 | 2026-06-18T10:51:13Z | chore: update to latest | .gitignore, apps/backend/eslint.config.ts, apps/backend/package.json, apps/backend/src/admin/tsconfig.json, apps/backend/tsconfig.json, apps/storefront/package.json, apps/storefront/src/app/[countryCode]/(main)/verify-account/page.tsx, apps/storefront/src/lib/data/cookies.ts |
| 682db7e | 2026-06-18T10:57:01Z | chore: remove comments | eslint.config.ts |
| a5c4955 | 2026-06-18T11:09:54Z | chore: add jiti | package.json, pnpm-lock.yaml |
| 4436f5b | 2026-06-18T11:21:56Z | chore: remove defaults | apps/backend/medusa-config.ts |
| 4f26176 | 2026-06-18T13:06:31Z | use different eslint | apps/backend/eslint.config.ts |
| a545d15 | 2026-06-24T15:11:40Z | Target product options release version | apps/backend/package.json, apps/storefront/package.json |
| fe344c3 | 2026-06-24T18:54:32Z | Refresh lock file | pnpm-lock.yaml |
| 9dec592 | 2026-06-24T19:03:01Z | Merge remote-tracking branch 'origin/main' into feat/global-product-options | .gitignore, apps/backend/eslint.config.ts, apps/backend/medusa-config.ts, apps/backend/package.json, apps/backend/src/admin/tsconfig.json, apps/backend/tsconfig.json, apps/storefront/src/app/[countryCode]/(main)/verify-account/page.tsx, apps/storefront/src/lib/data/cookies.ts |
| 58fa53b | 2026-06-24T19:04:05Z | Merge pull request #22 from medusajs/feat/global-product-options | apps/backend/package.json, apps/backend/src/migration-scripts/initial-data-seed.ts, apps/storefront/package.json, apps/storefront/src/app/[countryCode]/(main)/categories/[...category]/page.tsx, apps/storefront/src/app/[countryCode]/(main)/collections/[handle]/page.tsx, apps/storefront/src/app/[countryCode]/(main)/store/page.tsx, apps/storefront/src/lib/data/products.ts, apps/storefront/src/lib/util/product-option-filters.ts |

## high_churn_files
Evidence: file occurrence/change count from local git history when available; otherwise concrete GitHub changed-file payload from analysis if present.
| File | Commit touch/change count |
| --- | --- |
| pnpm-lock.yaml | 916 |
| apps/storefront/src/lib/data/customer.ts | 196 |
| apps/storefront/src/modules/store/components/refinement-list/options-picker/index.tsx | 164 |
| apps/storefront/src/modules/account/components/verify-account/index.tsx | 76 |
| apps/storefront/src/modules/store/components/refinement-list/index.tsx | 72 |
| apps/backend/src/migration-scripts/initial-data-seed.ts | 53 |
| apps/storefront/src/lib/data/cookies.ts | 45 |
| apps/storefront/src/lib/data/products.ts | 33 |
| apps/storefront/src/lib/util/product-option-filters.ts | 28 |
| apps/storefront/src/app/[countryCode]/(main)/verify-account/page.tsx | 27 |
| apps/backend/package.json | 24 |
| apps/storefront/src/modules/account/components/register/index.tsx | 18 |
| apps/storefront/src/app/[countryCode]/(main)/categories/[...category]/page.tsx | 16 |
| apps/storefront/src/app/[countryCode]/(main)/collections/[handle]/page.tsx | 16 |
| apps/storefront/src/app/[countryCode]/(main)/store/page.tsx | 16 |
| apps/storefront/src/modules/account/components/login/index.tsx | 16 |
| apps/storefront/package.json | 13 |
| apps/storefront/src/modules/categories/templates/index.tsx | 12 |
| package.json | 10 |
| apps/storefront/src/modules/collections/templates/index.tsx | 8 |
| apps/backend/eslint.config.ts | 7 |
| apps/backend/src/admin/tsconfig.json | 7 |
| eslint.config.ts | 7 |
| apps/backend/medusa-config.ts | 6 |
| apps/storefront/src/modules/store/templates/index.tsx | 6 |
| apps/storefront/src/modules/store/templates/paginated-products.tsx | 6 |
| apps/backend/tsconfig.json | 5 |
| apps/storefront/src/modules/store/components/refinement-list/sort-products/index.tsx | 4 |
| apps/storefront/tsconfig.tsbuildinfo | 4 |
| .gitignore | 3 |
| apps/storefront/src/modules/account/components/address-card/add-address.tsx | 3 |

## stable_files
Evidence: tracked files with zero touches in the latest 100 local git commits. Empty when no local `.git` evidence is available.
_No rows found from the available direct evidence._
