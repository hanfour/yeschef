import type { UiCheckRule } from '../types.js'
import { eyebrowLabelRule } from './eyebrow-label.js'
import { focusRemovedRule } from './focus-removed.js'
import { gradientTextRule } from './gradient-text.js'
import { pureBlackWhiteRule } from './pure-black-white.js'
import { sideStripeRule } from './side-stripe.js'
import { tinyTextRule } from './tiny-text.js'

export const uiCheckRules: readonly UiCheckRule[] = [
  sideStripeRule,
  gradientTextRule,
  eyebrowLabelRule,
  tinyTextRule,
  focusRemovedRule,
  pureBlackWhiteRule,
]
