// mongodbHelper.js
const axios = require('axios');
const config = require('../config/config');

// Base configuration
const BASE_URL = config.MONGODB_API_URL || 'http://185.112.147.79:8000/api';
const CSRF_PASSWORD = config.CSRF_PASSWORD || 'testpassword';

// Cache for CSRF token
let csrfToken = null;
let tokenExpiry = null;

/**
 * Get CSRF token with caching
 */
async function getCsrfToken() {
  if (csrfToken && tokenExpiry && Date.now() < tokenExpiry) {
    return csrfToken;
  }

  try {
    const response = await axios.post(`${BASE_URL}/csrf-token`, {
      password: CSRF_PASSWORD,
    });

    csrfToken = response.data.data.csrf;
    tokenExpiry = Date.now() + 55 * 60 * 1000; // 55 minutes

    return csrfToken;
  } catch (error) {
    throw new Error(`CSRF token fetch failed: ${error.message}`);
  }
}

/**
 * Get headers with CSRF token
 */
async function getHeaders() {
  const token = await getCsrfToken();
  return {
    'Content-Type': 'application/json',
    'X-CSRF-Token': token,
    'Connection': 'close'
  };
}

/**
 * CREATE - Insert a document
 * @param {string} collection - Collection name
 * @param {object} data - Document data
 * @param {string} modelKey - Optional model key for validation
 */
async function create(collection, data, modelKey = null) {
  try {
    const headers = await getHeaders();
    const payload = {
      collection_name: collection,
      document_data: data,
    };

    if (modelKey) {
      payload.model_key = modelKey;
    }

    const response = await axios.post(`${BASE_URL}/create`, payload, { headers });

    // Get the inserted ID
    const insertedId = response.data.data._id;

    // Fetch the complete document that was just created
    const fullDocResult = await findById(collection, insertedId);

    if (fullDocResult.success) {
      return {
        success: true,
        data: fullDocResult.data,
        id: insertedId,
      };
    } else {
      // Fallback to original response if fetch fails
      return {
        success: true,
        data: response.data.data,
        id: insertedId,
      };
    }
  } catch (error) {
    console.log(error, "error in create");
    return {
      success: false,
      error: error.response?.data?.message || error.message,
    };
  }
}

/**
 * READ - Get a document by ID
 * @param {string} collection - Collection name
 * @param {string} id - Document ID
 * @param {string} populate - Optional fields to populate
 */
async function findById(collection, id, populate = null) {
  try {
    const headers = await getHeaders();
    const params = {
      collection_name: collection,
      doc_id: id,
    };

    if (populate) {
      params.populate = populate;
    }

    const response = await axios.get(`${BASE_URL}/get`, { params, headers, withCredentials: true });
    return {
      success: true,
      data: response.data.data.data,
    };
  } catch (error) {
    console.log(error, "error in findById");
    return {
      success: false,
      error: error.response?.data?.message || error.message,
    };
  }
}


async function getAll(collection, populate = null) {
  try {
    const headers = await getHeaders();

    const params = {
      collection_name: collection
    };

    if (populate) {
      params.populate = populate;
    }

    const response = await axios.get(`${BASE_URL}/get`, {
      params,
      headers,
      withCredentials: true
    });

    return {
      success: true,
      data: response?.data?.data?.data
    };
  } catch (error) {
    return {
      success: false,
      error: error?.response?.data?.message || error.message
    };
  }
}

/**
 * UPDATE - Update a document by ID
 * @param {string} collection - Collection name
 * @param {string} id - Document ID
 * @param {object} data - Update data
 * @param {string} modelKey - Optional model key for validation
 */
async function updateById(collection, id, data, modelKey = null) {
  try {
    const headers = await getHeaders();
    const newData = { ...data, updated_at: new Date(Date.now()) };
    const payload = {
      collection_name: collection,
      doc_id: id,
      update_data: newData,
    };

    if (modelKey) {
      payload.model_key = modelKey;
    }
    const response = await axios.put(`${BASE_URL}/update`, payload, { headers });

    if (!response.data.data || !response.data.data._id) {
      const fullDocResult = await findById(collection, id);
      if (fullDocResult.success) {
        return {
          success: true,
          data: fullDocResult.data,
        };
      }
    }

    return {
      success: true,
      data: response.data.data,
    };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.message || error.message,
    };
  }
}

/**
 * DELETE - Delete a document by ID
 * @param {string} collection - Collection name
 * @param {string} id - Document ID
 */
async function deleteById(collection, id) {
  try {
    const headers = await getHeaders();
    const payload = {
      collection_name: collection,
      doc_id: id,
    };

    const response = await axios.delete(`${BASE_URL}/delete`, {
      headers,
      data: payload,
    });
    return {
      success: true,
      data: response.data.data,
    };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.message || error.message,
    };
  }
}

/**
 * FIND ONE - Find a document by field value
 * @param {string} collection - Collection name
 * @param {string} field - Field name
 * @param {any} value - Field value
 */
async function findOne(collection, field, value) {
  const headers = await getHeaders();
  try {
    const payload = {
      collection_name: collection,
      doc_name: field,
      field_value: value,
    };

    const response = await axios.post(`${BASE_URL}/find`, payload, { headers });

    const data = response.data.data;
    return {
      success: true,
      data: Array.isArray(data) ? (data.length > 0 ? data[0] : null) : data,
    };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.message || error.message,
    };
  }
}

/**
 * FIND MANY - Query multiple documents
 * @param {string} collection - Collection name
 * @param {object} query - MongoDB query object
 */
async function find(collection, query = {}) {
  try {
    const headers = await getHeaders();
    const queryEntries = Object.entries(query);

    if (queryEntries.length === 0) {
      const payload = {
        collection_name: collection,
      };
      const response = await axios.post(`${BASE_URL}/find`, payload, {
        headers,
      });

      return {
        success: true,
        data: response.data.data || [],
      };
    }

    if (queryEntries.length === 1) {
      const [fieldName, fieldValue] = queryEntries[0];

      const payload = {
        collection_name: collection,
        query: query,
      };

      const response = await axios.post(`${BASE_URL}/find`, payload, {
        headers,
      });

      return {
        success: true,
        data: response.data.data || [],
      };
    }

    if (queryEntries.length > 1) {
      const payload = {
        collection_name: collection,
        query: query,
      };

      const response = await axios.post(`${BASE_URL}/find`, payload, {
        headers,
      });

      return {
        success: true,
        data: response.data.data || [],
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.message || error.message,
    };
  }
}

/**
 * COUNT - Count documents matching query
 * @param {string} collection - Collection name
 * @param {object} query - MongoDB query object
 */

async function clearCollection(collection) {
  const headers = await getHeaders();
  try {
    const config = {
      method: 'delete',
      url: `${BASE_URL}/delete`,
      headers,
      data: {
        collection_name: collection,
        delete_all: true,
      },
    };
    await axios(config);
    console.log(`✅ [Clear Collection SUCCESS] ${collection}`);
  } catch (err) {
    console.error(`\n❌ [Clear Collection ERROR]`);
    console.error(err.response?.data || err.message);
  }
}

async function count(collection, query = {}) {
  try {
    const headers = await getHeaders();
    const payload = {
      collection_name: collection,
      query: query,
    };

    const response = await axios.post(`${BASE_URL}/count`, payload, { headers });
    return {
      success: true,
      data: response.data.data,
    };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.message || error.message,
    };
  }
}

async function paginate(collection, query = {}, page = 1, limit = 10, pipeline = []) {
  try {
    const headers = await getHeaders();
    const skip = (page - 1) * limit;

    const payload = {
      collection_name: collection,
      skip,
      limit,
      query,
    };

    // If a pipeline is provided, inject it
    if (Array.isArray(pipeline) && pipeline.length > 0) {
      payload.pipeline = pipeline;
    }
    console.log(payload, "payload in paginate")
    const response = await axios.post(`${BASE_URL}/paginate`, payload, {
      headers,
    });
    console.log(response.data, "response in paginate")
    const countResult = await count(collection, query);
    let totalResults = 0;

    if (countResult.success) {
      if (typeof countResult.data === 'number') {
        totalResults = countResult.data;
      } else if (countResult.data && typeof countResult.data.count === 'number') {
        totalResults = countResult.data.count;
      } else if (countResult.data && typeof countResult.data === 'object') {
        totalResults = Object.values(countResult.data)[0] || 0;
      }
    }

    const totalPages = Math.ceil(totalResults / limit);

    return {
      success: true,
      data: response.data.data,
      page: parseInt(page),
      limit: parseInt(limit),
      results: response.data.data,
      totalResults,
      totalPages,
    };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.message || error.message,
    };
  }
}

async function sort(collection, sortFields, query = {}) {
  try {
    const headers = await getHeaders();
    const payload = {
      collection_name: collection,
      sort_fields: sortFields,
      query: query,
    };

    const response = await axios.post(`${BASE_URL}/sort`, payload, { headers });

    const countResult = await count(collection, query);
    let totalResults = 0;
    if (countResult.success) {
      if (typeof countResult.data === 'number') {
        totalResults = countResult.data;
      } else if (countResult.data && typeof countResult.data.count === 'number') {
        totalResults = countResult.data.count;
      } else if (countResult.data && typeof countResult.data === 'object') {
        totalResults = Object.values(countResult.data)[0] || 0;
      }
    }

    return {
      success: true,
      data: response.data.data,
      totalResults: totalResults,
    };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.message || error.message,
    };
  }
}

/**
 * AGGREGATE - Run aggregation pipeline
 * @param {string} collection - Collection name
 * @param {array} pipeline - MongoDB aggregation pipeline
 */
async function aggregate(collection, pipeline) {
  try {
    const headers = await getHeaders();
    const payload = {
      collection_name: collection,
      pipeline: pipeline,
    };

    const response = await axios.post(`${BASE_URL}/aggregate`, payload, { headers });
    return {
      success: true,
      data: response.data.data,
    };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.message || error.message,
    };
  }
}

// Collection name mappings for convenience
const COLLECTIONS = {
  USERS: 'users',
  TABLES: 'tables',
  TABLE_TYPES: 'tabletypes',
  PLAYERS: 'players',
  GAME_STATES: 'gamestates',
  GAME_HISTORY: 'gamehistories',
  USER_STATS: 'userstats',
  ARCHIVED_TABLES: 'archivedtables',
  TABLE_PENDINGS: 'tablependings',
  ADMINS: 'admins',
  TOURNAMENT_TEMPLATES: 'tournamenttemplates',
  TOURNAMENTS: 'tournaments',
  TOURNAMENT_PLAYERS: 'tournamentplayers',
  TOURNAMENT_TABLES: 'tournamenttable',
  TIERS: 'tiers',
  SUB_TIERS: 'subtiers',
  MATCHMAKING_TABLES: 'matchmakingtables',
  COOLDOWNS: 'cooldowns',
  FUNDING_RECORDS: 'fundingrecords',
  RECRUIT_EARNINGS: 'recruitearnings',
};

// Model key mappings for validation
const MODELS = {
  USER: 'user',
  ADMIN: 'admin',
  TABLE: 'table',
  TABLE_TYPE: 'table_type',
  PLAYER: 'player',
  GAME_STATE: 'game_state',
  GAME_HISTORY: 'game_history',
  USER_STAT: 'user_stat',
  ARCHIVED_TABLE: 'archived_table',
  TABLE_PENDING: 'table_pending',
  TOURNAMENT_TEMPLATE: 'tournament_template',
  TOURNAMENT: 'tournament',
  TOURNAMENT_PLAYER: 'tournament_player',
  TOURNAMENT_TABLES: 'tournament_table',
  RECRUIT_EARNING: 'recruit_earning',
};

/**
 * POPULATE - Find document with populated references
 * @param {string} collection - Collection name
 * @param {string} id - Document ID
 * @param {array} populateFields - Array of populate configurations
 *
 * populateFields format:
 * [
 *   {
 *     path: 'currentPlayers', // field name to populate
 *     collection: 'players',  // target collection
 *     select: 'username status', // optional: fields to select
 *     populate: {              // optional: nested populate
 *       path: 'user',
 *       collection: 'users',
 *       select: 'username email'
 *     }
 *   }
 * ]
 */
async function findByIdWithPopulate(collection, id, populateFields = []) {
  try {
    const docResult = await findById(collection, id);
    if (!docResult.success || !docResult.data) {
      return docResult;
    }

    const document = docResult.data;
    const populatedDoc = { ...document };

    for (const populateConfig of populateFields) {
      const { path, collection: targetCollection, select, populate: nestedPopulate } = populateConfig;

      if (!populatedDoc[path]) {
        continue;
      }

      const fieldValue = populatedDoc[path];

      if (Array.isArray(fieldValue)) {
        const populatedArray = [];
        for (const refId of fieldValue) {
          if (!refId) continue; // Skip null/undefined references

          const refResult = await findById(targetCollection, refId);
          if (refResult.success && refResult.data) {
            let populatedItem = refResult.data;

            // Handle nested populate
            if (nestedPopulate && populatedItem[nestedPopulate.path]) {
              const nestedRefResult = await findById(nestedPopulate.collection, populatedItem[nestedPopulate.path]);
              if (nestedRefResult.success && nestedRefResult.data) {
                let nestedData = nestedRefResult.data;

                // Apply field selection for nested populate
                if (nestedPopulate.select) {
                  const selectFields = nestedPopulate.select.split(' ');
                  const selectedData = { _id: nestedData._id };
                  selectFields.forEach(field => {
                    if (nestedData[field] !== undefined) {
                      selectedData[field] = nestedData[field];
                    }
                  });
                  nestedData = selectedData;
                }

                populatedItem = {
                  ...populatedItem,
                  [nestedPopulate.path]: nestedData,
                };
              }
            }

            // Apply field selection for main populate
            if (select) {
              const selectFields = select.split(' ');
              const selectedData = { _id: populatedItem._id };
              selectFields.forEach(field => {
                if (populatedItem[field] !== undefined) {
                  selectedData[field] = populatedItem[field];
                }
              });
              populatedItem = selectedData;
            }

            populatedArray.push(populatedItem);
          }
        }
        populatedDoc[path] = populatedArray;
      } else if (fieldValue) {
        const refResult = await findById(targetCollection, fieldValue);
        if (refResult.success && refResult.data) {
          let populatedItem = refResult.data;

          // Handle nested populate for single reference
          if (nestedPopulate && populatedItem[nestedPopulate.path]) {
            const nestedRefResult = await findById(nestedPopulate.collection, populatedItem[nestedPopulate.path]);
            if (nestedRefResult.success && nestedRefResult.data) {
              let nestedData = nestedRefResult.data;

              if (nestedPopulate.select) {
                const selectFields = nestedPopulate.select.split(' ');
                const selectedData = { _id: nestedData._id };
                selectFields.forEach(field => {
                  if (nestedData[field] !== undefined) {
                    selectedData[field] = nestedData[field];
                  }
                });
                nestedData = selectedData;
              }

              populatedItem = {
                ...populatedItem,
                [nestedPopulate.path]: nestedData,
              };
            }
          }

          // Apply field selection for main populate
          if (select) {
            const selectFields = select.split(' ');
            const selectedData = { _id: populatedItem._id };
            selectFields.forEach(field => {
              if (populatedItem[field] !== undefined) {
                selectedData[field] = populatedItem[field];
              }
            });
            populatedItem = selectedData;
          }

          populatedDoc[path] = populatedItem;
        }
      }
    }

    return {
      success: true,
      data: populatedDoc,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * FIND WITH POPULATE - Find documents with populated references
 * @param {string} collection - Collection name
 * @param {object} query - MongoDB query object
 * @param {array} populateFields - Array of populate configurations
 */
async function findWithPopulate(collection, query = {}, populateFields = []) {
  try {
    // First get the documents
    const docsResult = await find(collection, query);
    if (!docsResult.success || !docsResult.data) {
      return docsResult;
    }

    const documents = docsResult.data;
    const populatedDocs = [];

    // Process each document with one level of nested population
    for (const doc of documents) {
      const populatedDoc = { ...doc };

      for (const populateConfig of populateFields) {
        const { path, collection: targetCollection, select, populate: nestedPopulate } = populateConfig;

        if (!populatedDoc[path]) continue;
        const fieldValue = populatedDoc[path];

        if (Array.isArray(fieldValue)) {
          const populatedArray = [];
          for (const refId of fieldValue) {
            const refResult = await findById(targetCollection, refId);
            if (refResult.success && refResult.data) {
              let populatedItem = refResult.data;

              // Handle ONE level of nested populate
              if (nestedPopulate && populatedItem[nestedPopulate.path]) {
                const nestedRefResult = await findById(nestedPopulate.collection, populatedItem[nestedPopulate.path]);
                if (nestedRefResult.success && nestedRefResult.data) {
                  // Apply field selection if specified
                  let nestedData = nestedRefResult.data;
                  if (nestedPopulate.select) {
                    const selectFields = nestedPopulate.select.split(' ');
                    const selectedData = { _id: nestedData._id };
                    selectFields.forEach(field => {
                      if (nestedData[field] !== undefined) {
                        selectedData[field] = nestedData[field];
                      }
                    });
                    nestedData = selectedData;
                  }

                  populatedItem = {
                    ...populatedItem,
                    [nestedPopulate.path]: nestedData,
                  };
                }
              }

              populatedArray.push(populatedItem);
            }
          }
          populatedDoc[path] = populatedArray;
        } else {
          const refResult = await findById(targetCollection, fieldValue);
          if (refResult.success && refResult.data) {
            let populatedItem = refResult.data;

            // Handle nested populate for single reference
            if (nestedPopulate && populatedItem[nestedPopulate.path]) {
              const nestedRefResult = await findById(nestedPopulate.collection, populatedItem[nestedPopulate.path]);
              if (nestedRefResult.success && nestedRefResult.data) {
                let nestedData = nestedRefResult.data;
                if (nestedPopulate.select) {
                  const selectFields = nestedPopulate.select.split(' ');
                  const selectedData = { _id: nestedData._id };
                  selectFields.forEach(field => {
                    if (nestedData[field] !== undefined) {
                      selectedData[field] = nestedData[field];
                    }
                  });
                  nestedData = selectedData;
                }

                populatedItem = {
                  ...populatedItem,
                  [nestedPopulate.path]: nestedData,
                };
              }
            }

            populatedDoc[path] = populatedItem;
          }
        }
      }

      populatedDocs.push(populatedDoc);
    }

    return {
      success: true,
      data: populatedDocs,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * FILTER - Advanced query with MongoDB operators
 * @param {string} collection - Collection name
 * @param {object} filterQuery - MongoDB filter query with operators
 */
async function filter(collection, filterQuery = {}) {
  try {
    const headers = await getHeaders();
    const payload = {
      collection_name: collection,
      filter_query: filterQuery,
    };

    const response = await axios.post(`${BASE_URL}/filter`, payload, { headers });
    return {
      success: true,
      data: response.data.data,
    };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.message || error.message,
    };
  }
}

module.exports = {
  // Core CRUD functions
  create,
  findById,
  updateById,
  deleteById,
  findOne,
  find,
  count,
  paginate,
  aggregate,
  findByIdWithPopulate,
  findWithPopulate,
  filter,
  sort,
  getAll,

  // Utility
  getCsrfToken,

  // Constants
  COLLECTIONS,
  MODELS,
};
