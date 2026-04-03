import {
  callGeminiText,
  extractGeminiText,
  extractGroundingLinks,
  getServerGeminiKey,
  jsonResponse,
  normalizeIngredientEntries,
  normalizeInstructionSteps,
  normalizeRecipeLinks,
  parseJsonBody,
  parseJsonFromGeminiText,
  preflightResponse,
  sanitizeGeminiJsonText,
} from './_lib/gemini.mjs';

const RECIPE_PARSE_FALLBACK = 'Gemini returned recipe text, but it was not valid structured JSON. Please try again.';
const RECIPE_SCHEMA_EXAMPLE = '{"recipeName":"Com chien duong chau","servings":2,"ingredients":[{"name":"cooked rice","quantity":"2 bowls","allergen":false}],"steps":["Heat oil in a wok and cook the aromatics first."],"allergyWarning":["Contains shrimp if using shrimp."],"youtubeQuery":"Com chien duong chau recipe"}';

export function OPTIONS() {
  return preflightResponse();
}

export async function POST(request) {
  const apiKey = getServerGeminiKey();
  if (!apiKey) {
    return jsonResponse(503, { error: 'Server is missing GEMINI_API_KEY. Add it in Vercel Project Settings > Environment Variables, then redeploy.' });
  }

  const body = await parseJsonBody(request);
  const dishName = String(body?.dishName || '').trim();
  const servings = Number(body?.servings) || 1;
  const allergies = Array.isArray(body?.allergies) ? body.allergies.map((value) => String(value).trim()).filter(Boolean) : [];

  if (!dishName) {
    return jsonResponse(400, { error: 'dishName is required.' });
  }

  const allergyText = allergies.length ? allergies.join(', ') : 'none';
  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: [
              `Dish name: ${dishName}`,
              `Servings: ${servings}`,
              `Allergies to watch: ${allergyText}`,
              'Use Google Search grounding to build a realistic home-cooking recipe from web knowledge.',
              'Return ONE valid JSON object only.',
              'Do not add markdown, code fences, comments, or explanatory text before or after the JSON.',
              'Use these exact field names: recipeName, servings, ingredients, steps, allergyWarning, youtubeQuery.',
              'The dish name may be Vietnamese. Preserve Vietnamese Unicode in values when relevant.',
              'Do not translate the JSON field names.',
              'Use this exact JSON shape:',
              RECIPE_SCHEMA_EXAMPLE,
              'Rules:',
              '- recipeName must be the requested dish or the closest real recipe name.',
              '- servings must be a positive number.',
              '- ingredients must be a realistic full shopping list for the requested servings.',
              '- ingredients[].quantity must be a short text amount like "200 g", "2 tbsp", "1 bowl", or "to taste".',
              '- ingredients[].allergen must be true only if the ingredient matches the listed allergies or is a common allergen worth flagging.',
              '- steps must be concrete real cooking steps, not placeholders.',
              '- allergyWarning must be an array of strings. Use [] when there is no warning.',
              '- youtubeQuery must be a short YouTube search query, not a URL.',
              '- Keep the ingredient list concise and useful for a home cook.',
            ].join('\n'),
          },
        ],
      },
    ],
    tools: [
      {
        google_search: {},
      },
    ],
    generationConfig: {
      temperature: 0.15,
      topP: 0.8,
      maxOutputTokens: 1100,
      responseMimeType: 'application/json',
    },
  };

  try {
    const payload = await callGeminiText(apiKey, requestBody);
    const text = extractGeminiText(payload);
    const parsed = parseJsonFromGeminiText(text);
    const normalizedRecipe = normalizeDishRecipePayload(parsed, { dishName, servings, allergies });
    const validationIssues = validateDishRecipePayload(normalizedRecipe);

    if (validationIssues.length) {
      console.error('[dish-plan] Gemini recipe payload was unreadable or incomplete.', {
        dishName,
        validationIssues,
        rawGeminiResponse: text,
        sanitizedGeminiResponse: sanitizeGeminiJsonText(text),
      });

      return jsonResponse(502, {
        error: 'Gemini returned an unreadable recipe payload.',
        fallbackText: RECIPE_PARSE_FALLBACK,
      });
    }

    const sourceLinks = extractGroundingLinks(payload?.candidates?.[0]?.groundingMetadata || payload?.groundingMetadata);
    const youtubeLinks = buildYoutubeLinks(normalizedRecipe);

    return jsonResponse(200, {
      title: normalizedRecipe.recipeName,
      serves: normalizedRecipe.servings,
      ingredients: normalizeIngredientEntries(normalizedRecipe.ingredients),
      steps: normalizedRecipe.steps,
      youtubeLinks: normalizeRecipeLinks(youtubeLinks, normalizedRecipe.recipeName),
      sourceLinks,
      allergyWarnings: normalizedRecipe.allergyWarning,
    });
  } catch (error) {
    return jsonResponse(error?.status || 502, {
      error: error?.message || 'Gemini dish plan request failed.',
      fallbackText: 'The recipe service could not finish this request right now. Please try again.',
    });
  }
}

function normalizeDishRecipePayload(parsed, context) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const recipeName = String(parsed.recipeName || parsed.title || parsed.name || context.dishName || '').trim();
  const normalizedIngredients = normalizeDishIngredients(parsed.ingredients || parsed.shoppingList || parsed.items, context.allergies);
  const steps = normalizeInstructionSteps(parsed.steps || parsed.instructions?.steps || parsed.instructions || parsed.method?.steps || parsed.method || parsed.directions);
  const allergyWarning = uniqueStrings([
    ...normalizeStringArray(parsed.allergyWarning || parsed.allergyWarnings || parsed.alerts),
    ...buildIngredientWarnings(normalizedIngredients, context.allergies),
  ]);
  const youtubeQuery = normalizeYoutubeQuery(parsed, recipeName);

  return {
    recipeName,
    servings: normalizeServings(parsed.servings ?? parsed.serves ?? context.servings),
    ingredients: normalizedIngredients,
    steps,
    allergyWarning,
    youtubeQuery,
    youtubeLinks: collectYoutubeLinks(parsed),
  };
}

function validateDishRecipePayload(recipe) {
  const issues = [];

  if (!recipe) {
    return ['missing_recipe_object'];
  }
  if (!recipe.recipeName) {
    issues.push('missing_recipe_name');
  }
  if (!Number.isFinite(recipe.servings) || recipe.servings <= 0) {
    issues.push('invalid_servings');
  }
  if (!Array.isArray(recipe.ingredients) || !recipe.ingredients.length) {
    issues.push('missing_ingredients');
  }
  if (!Array.isArray(recipe.steps) || !recipe.steps.length) {
    issues.push('missing_steps');
  }
  if (!recipe.youtubeQuery) {
    issues.push('missing_youtube_query');
  }

  return issues;
}

function normalizeDishIngredients(values, allergies) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((entry) => {
      const name = String(entry?.name || entry?.ingredient || entry?.item || entry?.food || '').trim();
      if (!name) {
        return null;
      }

      const quantity = String(entry?.quantity || entry?.amount || entry?.qty || entry?.measurement || '1 item').trim() || '1 item';
      const inferredAllergen = allergies.some((allergy) => name.toLowerCase().includes(allergy.toLowerCase()));

      return {
        name,
        quantity,
        allergen: coerceBoolean(entry?.allergen ?? entry?.isAllergen ?? entry?.containsAllergen, inferredAllergen),
      };
    })
    .filter(Boolean)
    .slice(0, 24);
}

function normalizeServings(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1;
}

function normalizeStringArray(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || '')
      .split(/[;\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean);

  return values
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeYoutubeQuery(parsed, recipeName) {
  const rawValue = parsed?.youtubeQuery || parsed?.youtubeSearch || parsed?.youtube || parsed?.videoQuery || '';
  const text = String(rawValue || '').trim();
  if (!text || /^https?:\/\//i.test(text)) {
    return `${recipeName} recipe`;
  }
  return text;
}

function collectYoutubeLinks(parsed) {
  const rawValues = [
    ...(Array.isArray(parsed?.youtubeLinks) ? parsed.youtubeLinks : [parsed?.youtubeLinks]),
    parsed?.youtubeUrl,
    parsed?.youtubeURL,
  ];

  return rawValues
    .map((value) => String(value || '').trim())
    .filter((value) => /^https?:\/\//i.test(value));
}

function buildYoutubeLinks(recipe) {
  const searchLink = `https://www.youtube.com/results?search_query=${encodeURIComponent(recipe.youtubeQuery || `${recipe.recipeName} recipe`)}`;
  return [...recipe.youtubeLinks, searchLink];
}

function buildIngredientWarnings(ingredients, allergies) {
  return ingredients
    .filter((ingredient) => ingredient.allergen || allergies.some((allergy) => ingredient.name.toLowerCase().includes(allergy.toLowerCase())))
    .map((ingredient) => `${ingredient.name} may conflict with the allergy profile.`);
}

function coerceBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }

  const text = String(value || '').trim().toLowerCase();
  if (!text) {
    return fallback;
  }
  if (['true', 'yes', '1', 'y'].includes(text)) {
    return true;
  }
  if (['false', 'no', '0', 'n'].includes(text)) {
    return false;
  }
  return fallback;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

