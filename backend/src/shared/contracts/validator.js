const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { SCHEMAS } = require('./schemas/http/index');

/**
 * Central Validation Service for FinMate AI
 * Provides a singleton Ajv instance and structured validation helpers.
 */
const ajv = new Ajv({
  allErrors: true,
  strict: false,
  useDefaults: true
});
addFormats(ajv);

// Load all schemas from the registry into Ajv for cross-reference support
Object.entries(SCHEMAS).forEach(([name, schema]) => {
  // We use the registry name as the schema ID for internal lookups
  ajv.addSchema(schema, name);
});

class ValidationError extends Error {
  constructor(schemaName, errors) {
    super(`Validation failed for schema: ${schemaName}`);
    this.name = 'ValidationError';
    this.schemaName = schemaName;
    this.errors = errors;
    this.code = 'VALIDATION_ERROR';
  }
}

/**
 * Validates data against a specified schema.
 * @param {string} schemaName - The name of the schema in the registry.
 * @param {any} data - The data to validate.
 * @throws {ValidationError} If validation fails.
 * @returns {any} The validated (and potentially mutated by defaults) data.
 */
function validate(schemaName, data) {
  const schema = ajv.getSchema(schemaName);
  if (!schema) {
    throw new Error(`Schema not found in registry: ${schemaName}`);
  }

  const valid = schema(data);
  if (!valid) {
    throw new ValidationError(schemaName, schema.errors);
  }

  return data;
}

const CALLER_ALLOWLIST = Object.freeze({
  ATLAS: new Set([
    'sentinel_get_surplus_baseline',
    'sentinel_run_goal_progress',
    'sentinel_run_goal_feasibility',
    'sentinel_validate_goal_change',
    'sentinel_check_available_balance',
    'sentinel_project_sip',
  ]),
  NOVA: new Set([
    'sentinel_get_ledger_summary',
    'sentinel_run_category_utilization',
    'sentinel_run_velocity_projection',
    'sentinel_detect_anomalies',
    'sentinel_run_rebalance_simulation',
    'sentinel_validate_cap_change',
  ]),
  IRIS: new Set([
    'sentinel_get_surplus_baseline',
    'sentinel_get_ledger_summary',
    'sentinel_run_spending_simulation',
    'sentinel_detect_anomalies',
    'sentinel_run_rebalance_simulation',
    'sentinel_validate_cap_change',
    'sentinel_run_goal_feasibility',
    'sentinel_validate_goal_change',
    'sentinel_forecast_bill_outlays',
    'sentinel_flag_cashflow_risk',
  ]),
  JOHN: new Set([
    'sentinel_get_surplus_baseline',
    'sentinel_get_ledger_summary',
    'sentinel_run_spending_simulation',
    'sentinel_forecast_bill_outlays',
    'sentinel_flag_cashflow_risk',
    'sentinel_compute_health_score',
  ]),
  WORKSPACE_API: new Set([
    'sentinel_get_surplus_baseline',
    'sentinel_get_ledger_summary',
    'sentinel_get_spending_timeseries',
    'sentinel_run_spending_simulation',
    'sentinel_run_category_utilization',
    'sentinel_run_velocity_projection',
    'sentinel_detect_anomalies',
    'sentinel_run_rebalance_simulation',
    'sentinel_validate_cap_change',
    'sentinel_run_goal_progress',
    'sentinel_run_goal_feasibility',
    'sentinel_validate_goal_change',
    'sentinel_check_available_balance',
    'sentinel_forecast_bill_outlays',
    'sentinel_flag_cashflow_risk',
    'sentinel_project_sip',
    'sentinel_compute_health_score',
  ]),
  BUDGET_MONITOR: new Set([
    'sentinel_run_category_utilization',
    'sentinel_detect_anomalies',
    'sentinel_forecast_bill_outlays',
    'sentinel_flag_cashflow_risk',
  ]),
});

function isToolAllowedForCaller(caller, functionName) {
  const allowed = CALLER_ALLOWLIST[caller];
  return allowed ? allowed.has(functionName) : false;
}

function getAllowedToolsForCaller(caller) {
  const allowed = CALLER_ALLOWLIST[caller];
  return allowed ? Array.from(allowed) : [];
}

function validateTaskPacket(packet) {
  if (!packet || typeof packet !== 'object') {
    return { valid: false, errors: ['Packet must be an object'] };
  }
  if (packet.schema !== 'TaskPacket@1') {
    return { valid: false, errors: ['Schema must be TaskPacket@1'] };
  }
  if (!packet.task_id || !packet.request_id || !packet.snapshot_id) {
    return { valid: false, errors: ['Missing required ID fields'] };
  }
  return { valid: true };
}

function validateSpecialistResponse(resp, pkt) {
  if (!resp || typeof resp !== 'object') {
    return { valid: false, errors: ['Response must be an object'] };
  }
  if (resp.schema !== 'SpecialistResponse@1') {
    return { valid: false, errors: ['Schema must be SpecialistResponse@1'] };
  }
  if (pkt && pkt.task_id && resp.task_id && resp.task_id !== pkt.task_id) {
    return { valid: false, errors: ['Task ID mismatch'] };
  }
  return { valid: true, errors: [] };
}

module.exports = {
  validate,
  ValidationError,
  ajv,
  CALLER_ALLOWLIST,
  isToolAllowedForCaller,
  getAllowedToolsForCaller,
  validateTaskPacket,
  validateSpecialistResponse,
};
