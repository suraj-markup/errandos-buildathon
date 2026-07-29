export type ControlShadowLanguageCode =
  | 'bn-IN'
  | 'en-IN'
  | 'gu-IN'
  | 'hi-IN'
  | 'hi-Latn-IN'
  | 'mr-IN';

export type ControlShadowTaskIntent =
  | 'add_product'
  | 'cancel_task'
  | 'inspect_cart'
  | 'prepare_checkout'
  | 'remove_product'
  | 'resolve_product_choice';

export type ControlShadowToolIntent =
  | 'add_cart_item'
  | 'cancel_current_task'
  | 'inspect_cart'
  | 'prepare_checkout'
  | 'remove_cart_item'
  | 'select_product';

export type ControlShadowClarification =
  | 'none'
  | 'required'
  | 'resolved';

export type ControlShadowProductEntityV1 = {
  brand?: string;
  packAmount?: number;
  packUnit?: 'g' | 'kg' | 'l' | 'ml' | 'piece';
  product: string;
  quantity: number;
};

export type SanitizedObservationMetadataV1 = {
  candidates: Array<{
    candidateId: string;
    ordinal: number;
    role: 'cart_item' | 'checkout_action' | 'product_option';
  }>;
  observationToken: string;
  screenKind: 'cart' | 'checkout_review' | 'product_choices';
};

export type ControlShadowExpectationV1 = {
  clarification: ControlShadowClarification;
  followUp: boolean;
  groundingCandidateId?: string;
  negatedOrdinals: number[];
  negatedProducts: string[];
  ordinal?: number;
  products: ControlShadowProductEntityV1[];
  taskIntent: ControlShadowTaskIntent;
  toolIntent: ControlShadowToolIntent;
};

export type ControlShadowCaseV1 = {
  caseId: string;
  expected: ControlShadowExpectationV1;
  languageCode: ControlShadowLanguageCode;
  languageLabel: string;
  observation?: SanitizedObservationMetadataV1;
  sarvamTranscript: string;
  version: 1;
};

/**
 * Fixed, sanitized Sarvam transcript fixtures. They contain no audio,
 * screenshots, coordinates, device identifiers, addresses, or cart contents.
 */
export const CONTROL_SHADOW_CORPUS_V1: readonly ControlShadowCaseV1[] = [
  {
    caseId: 'en_add_exact_milk',
    expected: {
      clarification: 'none',
      followUp: false,
      negatedOrdinals: [],
      negatedProducts: [],
      products: [{
        brand: 'Amul Taaza',
        packAmount: 500,
        packUnit: 'ml',
        product: 'milk',
        quantity: 2,
      }],
      taskIntent: 'add_product',
      toolIntent: 'add_cart_item',
    },
    languageCode: 'en-IN',
    languageLabel: 'English',
    sarvamTranscript: 'Add two packs of Amul Taaza milk, 500 millilitres each.',
    version: 1,
  },
  {
    caseId: 'en_ambiguous_milk',
    expected: {
      clarification: 'required',
      followUp: false,
      negatedOrdinals: [],
      negatedProducts: [],
      products: [{
        product: 'milk',
        quantity: 1,
      }],
      taskIntent: 'add_product',
      toolIntent: 'add_cart_item',
    },
    languageCode: 'en-IN',
    languageLabel: 'English',
    sarvamTranscript: 'Add milk.',
    version: 1,
  },
  {
    caseId: 'hi_add_grocery_list',
    expected: {
      clarification: 'none',
      followUp: false,
      negatedOrdinals: [],
      negatedProducts: [],
      products: [
        {
          brand: 'Amul Taaza',
          packAmount: 500,
          packUnit: 'ml',
          product: 'milk',
          quantity: 1,
        },
        {
          product: 'brown bread',
          quantity: 1,
        },
      ],
      taskIntent: 'add_product',
      toolIntent: 'add_cart_item',
    },
    languageCode: 'hi-IN',
    languageLabel: 'Hindi',
    sarvamTranscript: 'अमूल ताज़ा दूध का पाँच सौ मिली वाला एक पैकेट और एक ब्राउन ब्रेड जोड़ो।',
    version: 1,
  },
  {
    caseId: 'hi_followup_second_not_first',
    expected: {
      clarification: 'resolved',
      followUp: true,
      groundingCandidateId: 'option_2',
      negatedOrdinals: [1],
      negatedProducts: [],
      ordinal: 2,
      products: [],
      taskIntent: 'resolve_product_choice',
      toolIntent: 'select_product',
    },
    languageCode: 'hi-IN',
    languageLabel: 'Hindi',
    observation: {
      candidates: [
        { candidateId: 'option_1', ordinal: 1, role: 'product_option' },
        { candidateId: 'option_2', ordinal: 2, role: 'product_option' },
        { candidateId: 'option_3', ordinal: 3, role: 'product_option' },
      ],
      observationToken: 'fixture_hi_product_choices_3',
      screenKind: 'product_choices',
    },
    sarvamTranscript: 'पहला नहीं, दूसरा वाला चुनो।',
    version: 1,
  },
  {
    caseId: 'hinglish_add_chips',
    expected: {
      clarification: 'none',
      followUp: false,
      negatedOrdinals: [],
      negatedProducts: [],
      products: [{
        brand: "Lay's",
        packAmount: 52,
        packUnit: 'g',
        product: 'Classic Salted chips',
        quantity: 1,
      }],
      taskIntent: 'add_product',
      toolIntent: 'add_cart_item',
    },
    languageCode: 'hi-Latn-IN',
    languageLabel: 'Hinglish',
    sarvamTranscript: "Ek Lay's Classic Salted chips ka fifty-two gram pack add kar do.",
    version: 1,
  },
  {
    caseId: 'hinglish_negated_brand_followup',
    expected: {
      clarification: 'resolved',
      followUp: true,
      groundingCandidateId: 'option_2',
      negatedOrdinals: [1],
      negatedProducts: ['Amul Gold'],
      ordinal: 2,
      products: [{
        brand: 'Amul Taaza',
        packAmount: 500,
        packUnit: 'ml',
        product: 'milk',
        quantity: 1,
      }],
      taskIntent: 'resolve_product_choice',
      toolIntent: 'select_product',
    },
    languageCode: 'hi-Latn-IN',
    languageLabel: 'Hinglish',
    observation: {
      candidates: [
        { candidateId: 'option_1', ordinal: 1, role: 'product_option' },
        { candidateId: 'option_2', ordinal: 2, role: 'product_option' },
      ],
      observationToken: 'fixture_hinglish_product_choices_2',
      screenKind: 'product_choices',
    },
    sarvamTranscript: 'Amul Gold nahi, second wala Amul Taaza five hundred ml select karo.',
    version: 1,
  },
  {
    caseId: 'gu_add_bread',
    expected: {
      clarification: 'none',
      followUp: false,
      negatedOrdinals: [],
      negatedProducts: [],
      products: [{
        brand: 'Britannia',
        packAmount: 400,
        packUnit: 'g',
        product: 'brown bread',
        quantity: 2,
      }],
      taskIntent: 'add_product',
      toolIntent: 'add_cart_item',
    },
    languageCode: 'gu-IN',
    languageLabel: 'Gujarati',
    sarvamTranscript: 'બ્રિટાનિયા બ્રાઉન બ્રેડના ચારસો ગ્રામના બે પેકેટ ઉમેરો.',
    version: 1,
  },
  {
    caseId: 'gu_inspect_cart',
    expected: {
      clarification: 'none',
      followUp: false,
      negatedOrdinals: [],
      negatedProducts: [],
      products: [],
      taskIntent: 'inspect_cart',
      toolIntent: 'inspect_cart',
    },
    languageCode: 'gu-IN',
    languageLabel: 'Gujarati',
    sarvamTranscript: 'મારા કાર્ટમાં અત્યારે શું છે?',
    version: 1,
  },
  {
    caseId: 'mr_add_oil',
    expected: {
      clarification: 'none',
      followUp: false,
      negatedOrdinals: [],
      negatedProducts: [],
      products: [{
        brand: 'Fortune',
        packAmount: 1,
        packUnit: 'l',
        product: 'sunflower oil',
        quantity: 1,
      }],
      taskIntent: 'add_product',
      toolIntent: 'add_cart_item',
    },
    languageCode: 'mr-IN',
    languageLabel: 'Marathi',
    sarvamTranscript: 'फॉर्च्यून सूर्यफूल तेलाची एक लिटरची एक पिशवी कार्टमध्ये टाका.',
    version: 1,
  },
  {
    caseId: 'mr_cancel_followup',
    expected: {
      clarification: 'none',
      followUp: true,
      negatedOrdinals: [],
      negatedProducts: [],
      products: [],
      taskIntent: 'cancel_task',
      toolIntent: 'cancel_current_task',
    },
    languageCode: 'mr-IN',
    languageLabel: 'Marathi',
    sarvamTranscript: 'नको, हे काम रद्द करा.',
    version: 1,
  },
  {
    caseId: 'bn_add_eggs',
    expected: {
      clarification: 'none',
      followUp: false,
      negatedOrdinals: [],
      negatedProducts: [],
      products: [{
        packAmount: 6,
        packUnit: 'piece',
        product: 'eggs',
        quantity: 2,
      }],
      taskIntent: 'add_product',
      toolIntent: 'add_cart_item',
    },
    languageCode: 'bn-IN',
    languageLabel: 'Bengali',
    sarvamTranscript: 'ছয়টা ডিমের দুটো প্যাকেট যোগ করো।',
    version: 1,
  },
  {
    caseId: 'bn_followup_third_option',
    expected: {
      clarification: 'resolved',
      followUp: true,
      groundingCandidateId: 'option_3',
      negatedOrdinals: [],
      negatedProducts: [],
      ordinal: 3,
      products: [],
      taskIntent: 'resolve_product_choice',
      toolIntent: 'select_product',
    },
    languageCode: 'bn-IN',
    languageLabel: 'Bengali',
    observation: {
      candidates: [
        { candidateId: 'option_1', ordinal: 1, role: 'product_option' },
        { candidateId: 'option_2', ordinal: 2, role: 'product_option' },
        { candidateId: 'option_3', ordinal: 3, role: 'product_option' },
      ],
      observationToken: 'fixture_bn_product_choices_3',
      screenKind: 'product_choices',
    },
    sarvamTranscript: 'তিন নম্বরটা নাও।',
    version: 1,
  },
] as const;
