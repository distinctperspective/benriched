import { Hono } from 'hono';
import { Context } from 'hono';
import {
  addExclusionKeyword,
  addExclusionKeywords,
  removeExclusionKeyword,
  listExclusionKeywords,
} from '../../../lib/icp-exclusions.js';

/**
 * POST /v1/icp/exclusions
 * Add one or more ICP exclusion keywords
 *
 * Single: { "keyword": "field operations", "reason": "..." }
 * Batch:  { "keywords": ["field operations", "retail operations"], "reason": "..." }
 */
export async function handleAddExclusions(c: Context) {
  try {
    const body = await c.req.json();

    // Handle batch (keywords array) or single (keyword string)
    if (body.keywords && Array.isArray(body.keywords)) {
      const result = await addExclusionKeywords(body.keywords, body.reason);

      return c.json({
        success: true,
        data: {
          added: result.added,
          already_exists: result.alreadyExists,
          errors: result.errors.length > 0 ? result.errors : undefined,
          count: result.added.length,
        },
      });
    } else if (body.keyword) {
      const result = await addExclusionKeyword(body.keyword, body.reason);

      if (result.alreadyExists) {
        return c.json({
          success: false,
          error: 'Keyword already exists',
          keyword: body.keyword,
        }, 409);
      }

      if (!result.success) {
        return c.json({
          success: false,
          error: result.error,
        }, 400);
      }

      return c.json({
        success: true,
        data: result.data,
      }, 201);
    } else {
      return c.json({
        success: false,
        error: 'Missing required field: keyword or keywords',
      }, 400);
    }
  } catch (error) {
    console.error('Add exclusion error:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    }, 500);
  }
}

/**
 * GET /v1/icp/exclusions
 * List all ICP exclusion keywords
 */
export async function handleListExclusions(c: Context) {
  try {
    const keywords = await listExclusionKeywords();

    return c.json({
      success: true,
      data: keywords,
      count: keywords.length,
    });
  } catch (error) {
    console.error('List exclusions error:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    }, 500);
  }
}

/**
 * DELETE /v1/icp/exclusions/:keyword
 * Remove an ICP exclusion keyword
 */
export async function handleDeleteExclusion(c: Context) {
  try {
    const keyword = c.req.param('keyword');

    if (!keyword) {
      return c.json({
        success: false,
        error: 'Missing keyword parameter',
      }, 400);
    }

    // URL decode the keyword (in case it has spaces encoded as %20)
    const decodedKeyword = decodeURIComponent(keyword);

    const result = await removeExclusionKeyword(decodedKeyword);

    if (!result.success) {
      return c.json({
        success: false,
        error: result.error,
      }, 400);
    }

    return c.json({
      success: true,
      deleted: decodedKeyword,
    });
  } catch (error) {
    console.error('Delete exclusion error:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    }, 500);
  }
}

// Create Hono app for this route
const app = new Hono();

app.post('/', handleAddExclusions);
app.get('/', handleListExclusions);
app.delete('/:keyword', handleDeleteExclusion);

export default app;
