/**
 * Classifier Schema
 *
 * Zod schema for validating world state extraction from narrative responses.
 * The .describe() calls provide semantic guidance to LLMs via schema introspection.
 */

import * as z from 'zod'
import type { RuntimeVariable } from '$lib/services/packs/types'

// ============================================================================
// Visual Descriptors Schema
// ============================================================================

export const visualDescriptorsSchema = z
  .object({
    face: z.string().describe('Skin tone, facial features, expression, age indicators').optional(),
    hair: z
      .string()
      .describe('Color, length, style, texture (e.g., "wavy auburn hair to shoulders")')
      .optional(),
    eyes: z
      .string()
      .describe('Color, shape, notable features (e.g., "sharp green eyes")')
      .optional(),
    build: z
      .string()
      .describe('Height, body type, posture (e.g., "tall and lean", "broad-shouldered")')
      .optional(),
    clothing: z
      .string()
      .describe('Full outfit description (e.g., "worn leather armor over gray tunic")')
      .optional(),
    accessories: z
      .string()
      .describe('Jewelry, weapons, bags, distinctive items (e.g., "silver pendant, sword at hip")')
      .optional(),
    distinguishing: z
      .string()
      .describe('Scars, tattoos, birthmarks if any (e.g., "scar across left cheek")')
      .optional(),
  })
  .describe(
    'Visual appearance details for image generation - invent plausible details if not explicitly described',
  )

export type VisualDescriptors = z.infer<typeof visualDescriptorsSchema>

// ============================================================================
// Character Schemas
// ============================================================================

export const characterUpdateSchema = z.object({
  name: z.string().describe('Exact name of existing character to update'),
  changes: z.object({
    status: z
      .enum(['active', 'inactive', 'deceased'])
      .describe('active=present, inactive=away, deceased=dead')
      .optional(),
    relationship: z.string().describe('New relationship to protagonist').optional(),
    newTraits: z.array(z.string()).describe('Personality traits to add').optional(),
    removeTraits: z.array(z.string()).describe('Traits no longer applicable').optional(),
    visualDescriptors: visualDescriptorsSchema
      .describe('Complete visual appearance - replaces existing descriptors')
      .optional(),
  }),
})

export const newCharacterSchema = z.object({
  name: z.string().describe("Character's proper name"),
  description: z.string().describe('One sentence description').optional(),
  relationship: z.string().describe('friend, enemy, ally, neutral, or unknown').optional(),
  traits: z.array(z.string()).describe('Personality traits').optional(),
  visualDescriptors: visualDescriptorsSchema
    .describe('Complete visual appearance - ALL categories should be filled')
    .optional(),
  status: z
    .enum(['active', 'inactive', 'deceased'])
    .describe('active if present in scene')
    .optional(),
})

// ============================================================================
// Location Schemas
// ============================================================================

/**
 * No `current` here: `scene.currentLocationName` is the only thing that moves the scene.
 * Both existed and both were applied, in an order the model could not see, so a response
 * naming two different places silently kept whichever ran last.
 */
export const locationUpdateSchema = z.object({
  name: z.string().describe('Exact name of existing location'),
  changes: z.object({
    visited: z.boolean().describe('true if the protagonist has been here').optional(),
    description: z
      .string()
      .describe('Replaces the whole description; only for a location whose current text is shown')
      .optional(),
    descriptionAddition: z.string().describe('New details learned about location').optional(),
  }),
})

export const newLocationSchema = z.object({
  name: z.string().describe("Location's proper name"),
  description: z.string().describe('One sentence description').optional(),
  visited: z.boolean().describe('true if the protagonist has been here').optional(),
})

// ============================================================================
// Item Schemas
// ============================================================================

export const itemUpdateSchema = z.object({
  name: z.string().describe('Exact name of existing item'),
  changes: z.object({
    quantity: z.number().describe('New quantity').optional(),
    location: z.string().describe('inventory, worn, or location name').optional(),
    equipped: z.boolean().describe('true if currently worn/wielded').optional(),
  }),
})

export const newItemSchema = z.object({
  name: z.string().describe('Item name'),
  description: z.string().describe('One sentence description').optional(),
  quantity: z.number().describe('How many (default 1)').optional(),
  location: z.string().describe('inventory, worn, or location name').optional(),
  equipped: z.boolean().describe('true if currently worn/wielded').optional(),
})

// ============================================================================
// Story Beat Schemas
// ============================================================================

export const storyBeatUpdateSchema = z.object({
  title: z.string().describe('Exact title of existing beat'),
  changes: z.object({
    status: z
      .enum(['pending', 'active', 'completed', 'failed'])
      .describe('completed when resolved, failed if impossible')
      .optional(),
    description: z.string().describe('Updated description').optional(),
  }),
})

export const newStoryBeatSchema = z.object({
  title: z.string().describe('Short title (3-6 words)'),
  description: z.string().describe('What happened or needs to happen').optional(),
  type: z
    .enum(['milestone', 'quest', 'revelation', 'event', 'plot_point'])
    .describe('milestone, quest, revelation, event, or plot_point')
    .optional(),
  status: z
    .enum(['pending', 'active', 'completed', 'failed'])
    .describe('pending=upcoming, active=in-progress, completed=done')
    .optional(),
})

// ============================================================================
// Entry Updates Schema
// ============================================================================

export const entryUpdatesSchema = z.object({
  characterUpdates: z.array(characterUpdateSchema).default([]),
  locationUpdates: z.array(locationUpdateSchema).default([]),
  itemUpdates: z.array(itemUpdateSchema).default([]),
  storyBeatUpdates: z.array(storyBeatUpdateSchema).default([]),
  newCharacters: z.array(newCharacterSchema).default([]),
  newLocations: z.array(newLocationSchema).default([]),
  newItems: z.array(newItemSchema).default([]),
  newStoryBeats: z.array(newStoryBeatSchema).default([]),
})

// ============================================================================
// Scene Schema
// ============================================================================

export const sceneSchema = z.object({
  currentLocationName: z
    .string()
    .nullable()
    .describe('Name of current scene location, or null')
    .optional(),
  presentCharacterNames: z
    .array(z.string())
    .describe(
      'Every other character in the scene at the end of the passage, named exactly as the character list spells them. Anyone left out is treated as away',
    )
    .default([]),
  timeProgression: z
    .enum(['none', 'minutes', 'hours', 'days'])
    .describe('none=instant, minutes=conversations, hours=travel, days=sleep')
    .default('none'),
})

// ============================================================================
// Main Classification Result Schema
// ============================================================================

export const classificationResultSchema = z.object({
  entryUpdates: entryUpdatesSchema,
  scene: sceneSchema,
})

// Same validation contract; extraction must not invent facts for the collaborative Writer.
const collaborativeVisualDescriptorsSchema = visualDescriptorsSchema
  .extend({
    face: z
      .preprocess(
        (value) => (value === null ? undefined : value),
        visualDescriptorsSchema.shape.face,
      )
      .describe('仅记录正文明确描述的面部特征，不推断肤色或年龄；未明确则省略。'),
    hair: z
      .preprocess(
        (value) => (value === null ? undefined : value),
        visualDescriptorsSchema.shape.hair,
      )
      .describe('仅记录正文明确描述的头发，不补充颜色、长度或发型；未明确则省略。'),
    eyes: z
      .preprocess(
        (value) => (value === null ? undefined : value),
        visualDescriptorsSchema.shape.eyes,
      )
      .describe('仅记录正文明确描述的眼睛，不推断颜色或形状；未明确则省略。'),
    build: z
      .preprocess(
        (value) => (value === null ? undefined : value),
        visualDescriptorsSchema.shape.build,
      )
      .describe('仅记录正文明确描述的体型或姿态，不推断身高体格；未明确则省略。'),
    clothing: z
      .preprocess(
        (value) => (value === null ? undefined : value),
        visualDescriptorsSchema.shape.clothing,
      )
      .describe('仅记录正文明确描述的衣着，不补全整套服装；未明确则省略。'),
    accessories: z
      .preprocess(
        (value) => (value === null ? undefined : value),
        visualDescriptorsSchema.shape.accessories,
      )
      .describe('仅记录正文明确描述的配饰及随身物品，不添加合理但未出现的物品；未明确则省略。'),
    distinguishing: z
      .preprocess(
        (value) => (value === null ? undefined : value),
        visualDescriptorsSchema.shape.distinguishing,
      )
      .describe('仅记录正文明确描述的疤痕、纹身等特征，不推断或创造；未明确则省略。'),
  })
  .describe(
    '仅用中文提取已生成正文明确给出的外貌事实。未知类别省略，不为图像生成补全，不推断或创造细节。',
  )

const attributedFactDescription =
  '正文中作者明确叙述的历史、NPC视角直接呈现的行为及场外事件可以记为事实；人物对白、专业判断、主观回忆或宣布的未来安排须保留说话人及确定程度。读者所见不等于角色所知，相关字段保留正文明确的知情范围与信息渠道，未说明的知情状态保持未定；只呈现线索时不补出答案，未写入正文的导演构想、规划及被拒版本不是事实。观察到的痕迹与人物对其原因的解释分开，不因解释合理或无人反驳就写成已证实。未回应只记尚未回应，不升级成拒绝、默许或承诺；行为没有发生不等于人物已决定不做。历史发生时间与主角当前状态分开，不用闪回覆盖当前关系或位置。'

export const collaborativeCharacterUpdateSchema = characterUpdateSchema.extend({
  changes: characterUpdateSchema.shape.changes.extend({
    status: characterUpdateSchema.shape.changes.shape.status.describe(
      'active表示主角当前时间线最后明确所在的现场仍在场，inactive表示离开该现场，deceased仅在当前时间线已死亡；NPC场外镜头和历史闪回不改变其是否在主角现场的状态，不用过去生死状态覆盖现在。',
    ),
    relationship: characterUpdateSchema.shape.changes.shape.relationship.describe(
      `完整替换双方当前关系、立场及已答应或尚待答应的条件；事件过程与证据细目归线程，不写整轮流水账。${attributedFactDescription}`,
    ),
    newTraits: characterUpdateSchema.shape.changes.shape.newTraits.describe(
      '只添加有直接依据的稳定人物特质，不把他人评价、单次反应或尚未核实的传言提炼为确定特质。',
    ),
    visualDescriptors: z
      .preprocess(
        (value) => (value === null ? undefined : value),
        collaborativeVisualDescriptorsSchema.optional(),
      )
      .describe(
        '按类别增量更新：只返回正文明确改变或补充的类别；未返回、空值或空白类别保留旧值，不必重复所有外貌。',
      )
      .optional(),
  }),
})

export const collaborativeNewCharacterSchema = newCharacterSchema.extend({
  relationship: newCharacterSchema.shape.relationship.describe(
    `仅描述已成立的人物关系，不把陌生人的自称或未经证实的身份写成确定关系。${attributedFactDescription}`,
  ),
  status: newCharacterSchema.shape.status.describe(
    '仅在主角当前时间线最后明确所在的现场仍在场才 active；只在NPC场外镜头、回忆、转述或远程联络中出现为 inactive，不能把新增人物等同于新入场；当前时间线已死亡则为 deceased。',
  ),
  description: newCharacterSchema.shape.description.describe(attributedFactDescription),
  traits: newCharacterSchema.shape.traits.describe(
    '没有直接依据的稳定特质则省略；他人评价放在保留来源的 description 中，不能洗成确定 traits。',
  ),
  visualDescriptors: collaborativeVisualDescriptorsSchema.optional(),
})

export const collaborativeSceneSchema = sceneSchema.extend({
  currentLocationName: sceneSchema.shape.currentLocationName.describe(
    '主角当前时间线最后明确所在的地点，无新移动则保留原地点；结尾的NPC场外镜头、历史闪回和未来设想不移动主角。',
  ),
  presentCharacterNames: sceneSchema.shape.presentCharacterNames.describe(
    '主角当前时间线最后明确所在的现场仍在场的全部其他人物，不含主角，按已有名称列出，包括本轮未发言者；结尾切镜或闪回不替换该名单，只有确无他人在场才为空数组。',
  ),
  timeProgression: sceneSchema.shape.timeProgression.describe(
    '仅依据主角当前时间线明确经过的时间选择 minutes、hours 或 days；没有明确时间证据则输出 none。回忆中的多年间隔、NPC场外时间和未来设想不推进主角时钟，不得根据对话、旅行或睡眠自行推断经过的时间。',
  ),
})

export const collaborativeClassificationResultSchema = classificationResultSchema
  .extend({
    entryUpdates: entryUpdatesSchema.extend({
      characterUpdates: z.array(collaborativeCharacterUpdateSchema).default([]),
      newCharacters: z.array(collaborativeNewCharacterSchema).default([]),
      itemUpdates: z
        .array(
          itemUpdateSchema.extend({
            changes: itemUpdateSchema.shape.changes.extend({
              location: itemUpdateSchema.shape.changes.shape.location.describe(
                '只有实际持有、交付、收取或移动才更新；声称要装入箱柜不等于已装入，箱柜搬走不代表未装入的物品随行。未执行仍保留原位置，不替正文补动作。',
              ),
            }),
          }),
        )
        .default([]),
      locationUpdates: z
        .array(
          locationUpdateSchema.extend({
            changes: locationUpdateSchema.shape.changes.extend({
              description: locationUpdateSchema.shape.changes.shape.description.describe(
                `完整替换已展示旧描述的地点环境、布局与用途，不混入人物的一过性活动。${attributedFactDescription}`,
              ),
              descriptionAddition:
                locationUpdateSchema.shape.changes.shape.descriptionAddition.describe(
                  `只追加环境、布局或用途的实际变化，不追加人物活动，不与 description 重复。${attributedFactDescription}`,
                ),
            }),
          }),
        )
        .default([]),
      newLocations: z
        .array(
          newLocationSchema.extend({
            description: newLocationSchema.shape.description.describe(attributedFactDescription),
          }),
        )
        .default([]),
      newItems: z
        .array(
          newItemSchema.extend({
            description: newItemSchema.shape.description.describe(
              `物品可识别特征、用途和来历；未签名、待领取等可变进度归线程，不写成无法后续更新的属性。${attributedFactDescription}`,
            ),
          }),
        )
        .default([]),
      storyBeatUpdates: z
        .array(
          storyBeatUpdateSchema.extend({
            changes: storyBeatUpdateSchema.shape.changes.extend({
              description: storyBeatUpdateSchema.shape.changes.shape.description.describe(
                `只更新本轮有变化的线程，完整保留关键依据、当前进度、未解部分及承诺条件，不重述完整过程。${attributedFactDescription}`,
              ),
            }),
          }),
        )
        .default([]),
      newStoryBeats: z
        .array(
          newStoryBeatSchema.extend({
            description: newStoryBeatSchema.shape.description.describe(
              `仅记录正文已引入的事件或未解问题，候选安排不是已完成事件。${attributedFactDescription}`,
            ),
          }),
        )
        .default([]),
    }),
    scene: collaborativeSceneSchema,
  })
  .describe(
    '只从已生成正文提取明确成立的事实，以中文输出。不得把规划、猜测或合理推断写成事实；没有明确证据的可选字段省略。',
  )

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Clamp a number to min/max bounds if defined.
 * Used after LLM extraction to enforce number constraints that can't be expressed in Zod schemas.
 */
export function clampNumber(value: number, min?: number, max?: number): number {
  let result = value
  if (min !== undefined && result < min) result = min
  if (max !== undefined && result > max) result = max
  return result
}

// ============================================================================
// Type Exports
// ============================================================================

export type CharacterUpdate = z.infer<typeof characterUpdateSchema>
export type NewCharacter = z.infer<typeof newCharacterSchema>
export type LocationUpdate = z.infer<typeof locationUpdateSchema>
export type NewLocation = z.infer<typeof newLocationSchema>
export type ItemUpdate = z.infer<typeof itemUpdateSchema>
export type NewItem = z.infer<typeof newItemSchema>
export type StoryBeatUpdate = z.infer<typeof storyBeatUpdateSchema>
export type NewStoryBeat = z.infer<typeof newStoryBeatSchema>
export type EntryUpdates = z.infer<typeof entryUpdatesSchema>
export type Scene = z.infer<typeof sceneSchema>
export type ClassificationResult = z.infer<typeof classificationResultSchema> & {
  /** Internal metadata: runtime variable definitions for use by applyClassificationResult. Not LLM output. */
  _runtimeVarDefs?: RuntimeVariable[]
  /**
   * Internal metadata: why this result is thinner than the model's output, if it is.
   * Not LLM output.
   *
   * An empty classification and a failed one are the same object, and the difference
   * matters to the user — "nothing happened this turn" and "the world update was thrown
   * away" look identical in the world panel. Set by ClassifierService when the response
   * failed validation, so the UI can say so instead of leaving the player to notice a
   * missing location three turns later.
   */
  _error?: string
}
