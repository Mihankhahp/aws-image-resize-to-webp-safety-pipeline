// Fake @aws-sdk/lib-dynamodb with the validations real DynamoDB applies to
// the expressions these handlers use (unused/missing values, overlapping
// paths, reserved words, undefined values).
import { state, simulate, awsError, clone } from './state.mjs';

class Command {
  constructor(input) {
    this.input = input;
  }
}
export class PutCommand extends Command {}
export class GetCommand extends Command {}
export class UpdateCommand extends Command {}

const RESERVED = new Set(
  `ABORT ABSOLUTE ACTION ADD AFTER AGENT AGGREGATE ALL ALLOCATE ALTER ANALYZE AND ANY ARCHIVE ARE ARRAY AS ASC ASCII ASENSITIVE ASSERTION ASYMMETRIC AT ATOMIC ATTACH ATTRIBUTE AUTH AUTHORIZATION AUTHORIZE AUTO AVG BACK BACKUP BASE BATCH BEFORE BEGIN BETWEEN BIGINT BINARY BIT BLOB BLOCK BOOLEAN BOTH BREADTH BUCKET BULK BY BYTE CALL CALLED CALLING CAPACITY CASCADE CASCADED CASE CAST CATALOG CHAR CHARACTER CHECK CLASS CLOB CLOSE CLUSTER CLUSTERED CLUSTERING CLUSTERS COALESCE COLLATE COLLATION COLLECTION COLUMN COLUMNS COMBINE COMMENT COMMIT COMPACT COMPILE COMPRESS CONDITION CONFLICT CONNECT CONNECTION CONSISTENCY CONSISTENT CONSTRAINT CONSTRAINTS CONSTRUCTOR CONSUMED CONTINUE CONVERT COPY CORRESPONDING COUNT COUNTER CREATE CROSS CUBE CURRENT CURSOR CYCLE DATA DATABASE DATE DATETIME DAY DEALLOCATE DEC DECIMAL DECLARE DEFAULT DEFERRABLE DEFERRED DEFINE DEFINED DEFINITION DELETE DELIMITED DEPTH DEREF DESC DESCRIBE DESCRIPTOR DETACH DETERMINISTIC DIAGNOSTICS DIRECTORIES DISABLE DISCONNECT DISTINCT DISTRIBUTE DO DOMAIN DOUBLE DROP DUMP DURATION DYNAMIC EACH ELEMENT ELSE ELSEIF EMPTY ENABLE END EQUAL EQUALS ERROR ESCAPE ESCAPED EVAL EVALUATE EXCEEDED EXCEPT EXCEPTION EXCEPTIONS EXCLUSIVE EXEC EXECUTE EXISTS EXIT EXPLAIN EXPLODE EXPORT EXPRESSION EXTENDED EXTERNAL EXTRACT FAIL FALSE FAMILY FETCH FIELDS FILE FILTER FILTERING FINAL FINISH FIRST FIXED FLATTERN FLOAT FOR FORCE FOREIGN FORMAT FORWARD FOUND FREE FROM FULL FUNCTION FUNCTIONS GENERAL GENERATE GET GLOB GLOBAL GO GOTO GRANT GREATER GROUP GROUPING HANDLER HASH HAVE HAVING HEAP HIDDEN HOLD HOUR IDENTIFIED IDENTITY IF IGNORE IMMEDIATE IMPORT IN INCLUDING INCLUSIVE INCREMENT INCREMENTAL INDEX INDEXED INDEXES INDICATOR INFINITE INITIALLY INLINE INNER INNTER INOUT INPUT INSENSITIVE INSERT INSTEAD INT INTEGER INTERSECT INTERVAL INTO INVALIDATE IS ISOLATION ITEM ITEMS ITERATE JOIN KEY KEYS LAG LANGUAGE LARGE LAST LATERAL LEAD LEADING LEAVE LEFT LENGTH LESS LEVEL LIKE LIMIT LIMITED LINES LIST LOAD LOCAL LOCALTIME LOCALTIMESTAMP LOCATION LOCATOR LOCK LOCKS LOG LOGED LONG LOOP LOWER MAP MATCH MATERIALIZED MAX MAXLEN MEMBER MERGE METHOD METRICS MIN MINUS MINUTE MISSING MOD MODE MODIFIES MODIFY MODULE MONTH MULTI MULTISET NAME NAMES NATIONAL NATURAL NCHAR NCLOB NEW NEXT NO NONE NOT NULL NULLIF NUMBER NUMERIC OBJECT OF OFFLINE OFFSET OLD ON ONLINE ONLY OPAQUE OPEN OPERATOR OPTION OR ORDER ORDINALITY OTHER OTHERS OUT OUTER OUTPUT OVER OVERLAPS OVERRIDE OWNER PAD PARALLEL PARAMETER PARAMETERS PARTIAL PARTITION PARTITIONED PARTITIONS PATH PERCENT PERCENTILE PERMISSION PERMISSIONS PIPE PIPELINED PLAN POOL POSITION PRECISION PREPARE PRESERVE PRIMARY PRIOR PRIVATE PRIVILEGES PROCEDURE PROCESSED PROJECT PROJECTION PROPERTY PROVISIONING PUBLIC PUT QUERY QUIT QUORUM RAISE RANDOM RANGE RANK RAW READ READS REAL REBUILD RECORD RECURSIVE REDUCE REF REFERENCE REFERENCES REFERENCING REGEXP REGION REINDEX RELATIVE RELEASE REMAINDER RENAME REPEAT REPLACE REQUEST RESET RESIGNAL RESOURCE RESPONSE RESTORE RESTRICT RESULT RETURN RETURNING RETURNS REVERSE REVOKE RIGHT ROLE ROLES ROLLBACK ROLLUP ROUTINE ROW ROWS RULE RULES SAMPLE SATISFIES SAVE SAVEPOINT SCAN SCHEMA SCOPE SCROLL SEARCH SECOND SECTION SEGMENT SEGMENTS SELECT SELF SEMI SENSITIVE SEPARATE SEQUENCE SERIALIZABLE SESSION SET SETS SHARD SHARE SHARED SHORT SHOW SIGNAL SIMILAR SIZE SKEWED SMALLINT SNAPSHOT SOME SOURCE SPACE SPACES SPARSE SPECIFIC SPECIFICTYPE SPLIT SQL SQLCODE SQLERROR SQLEXCEPTION SQLSTATE SQLWARNING START STATE STATIC STATUS STORAGE STORE STORED STREAM STRING STRUCT STYLE SUB SUBMULTISET SUBPARTITION SUBSTRING SUBTYPE SUM SUPER SYMMETRIC SYNONYM SYSTEM TABLE TABLESAMPLE TEMP TEMPORARY TERMINATED TEXT THAN THEN THROUGHPUT TIME TIMESTAMP TIMEZONE TINYINT TO TOKEN TOTAL TOUCH TRAILING TRANSACTION TRANSFORM TRANSLATE TRANSLATION TREAT TRIGGER TRIM TRUE TRUNCATE TTL TUPLE TYPE UNDER UNDO UNION UNIQUE UNIT UNKNOWN UNLOGGED UNNEST UNPROCESSED UNSIGNED UNTIL UPDATE UPPER URL USAGE USE USER USERS USING UUID VACUUM VALUE VALUED VALUES VARCHAR VARIABLE VARIANCE VARINT VARYING VIEW VIEWS VIRTUAL VOID WAIT WHEN WHENEVER WHERE WHILE WINDOW WITH WITHIN WITHOUT WORK WRAPPED WRITE YEAR ZONE`.split(
    /\s+/,
  ),
);

function validation(msg) {
  return awsError('ValidationException', msg);
}
function assertNoUndefined(obj, where) {
  for (const [k, v] of Object.entries(obj || {}))
    if (v === undefined)
      throw new Error(
        `Pass options.removeUndefinedValues=true to remove undefined values (${where} ${k})`,
      );
}
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Supports the condition forms the handlers use: attribute_(not_)exists(p),
// p IN (:a, :b), p = :v, p <> :v, joined with OR / AND.
function evalCondition(current, expr, resolveName, resolveValue) {
  const term = (t) => {
    t = t.trim();
    let m;
    if ((m = t.match(/^attribute_not_exists\((.+)\)$/)))
      return !(resolveName(m[1]) in current);
    if ((m = t.match(/^attribute_exists\((.+)\)$/)))
      return resolveName(m[1]) in current;
    if ((m = t.match(/^(\S+)\s+IN\s+\((.+)\)$/))) {
      const name = resolveName(m[1]);
      const options = m[2].split(',').map((v) => resolveValue(v));
      return name in current && options.some((v) => v === current[name]);
    }
    if ((m = t.match(/^(\S+)\s*(=|<>)\s*(:\w+)$/))) {
      const name = resolveName(m[1]);
      const v = resolveValue(m[3]);
      if (!(name in current)) return false; // comparisons on a missing attribute are false
      return m[2] === '=' ? current[name] === v : current[name] !== v;
    }
    throw new Error(`fake DDB: unsupported condition term ${t}`);
  };
  return expr
    .split(/\s+OR\s+/)
    .some((orPart) => orPart.split(/\s+AND\s+/).every(term));
}

function applyUpdate(item, input, current) {
  const {
    UpdateExpression: expr,
    ExpressionAttributeValues: values = {},
    ExpressionAttributeNames: names = {},
  } = input;
  assertNoUndefined(values, 'ExpressionAttributeValues');
  const usedValues = new Set();
  const usedNames = new Set();
  const resolveName = (tok) => {
    tok = tok.trim();
    if (tok.startsWith('#')) {
      if (!(tok in names))
        throw validation(
          `An expression attribute name used in the document path is not defined; attribute name: ${tok}`,
        );
      usedNames.add(tok);
      return names[tok];
    }
    if (RESERVED.has(tok.toUpperCase()))
      throw validation(
        `Attribute name is a reserved keyword; reserved keyword: ${tok}`,
      );
    return tok;
  };
  const resolveValue = (tok) => {
    tok = tok.trim();
    if (!(tok in values))
      throw validation(
        `An expression attribute value used in expression is not defined; attribute value: ${tok}`,
      );
    usedValues.add(tok);
    return clone(values[tok]);
  };

  const clauses = [
    ...expr.matchAll(/\b(SET|REMOVE)\b([\s\S]*?)(?=\b(?:SET|REMOVE)\b|$)/g),
  ];
  const setOps = [];
  const removeOps = [];
  for (const [, kw, body] of clauses) {
    for (const part of splitTopLevel(body)) {
      if (kw === 'REMOVE') removeOps.push(resolveName(part));
      else {
        const [lhs, rhs] = part.split(/=(.*)/s).map((x) => x.trim());
        const target = resolveName(lhs);
        const m = rhs.match(/^if_not_exists\(\s*([^,]+?)\s*,\s*(:\w+)\s*\)$/);
        if (m) {
          const path = resolveName(m[1]);
          const v = resolveValue(m[2]);
          setOps.push([target, (it) => (path in it ? it[path] : v)]);
        } else if (/^:\w+$/.test(rhs)) {
          const v = resolveValue(rhs);
          setOps.push([target, () => v]);
        } else throw new Error(`fake DDB: unsupported SET value ${rhs}`);
      }
    }
  }
  const conditionHolds = input.ConditionExpression
    ? evalCondition(
        current,
        input.ConditionExpression,
        resolveName,
        resolveValue,
      )
    : true;
  const setTargets = setOps.map(([t]) => t);
  const overlap = removeOps.filter((r) => setTargets.includes(r));
  if (overlap.length || new Set(setTargets).size !== setTargets.length)
    throw validation(
      `Two document paths overlap with each other: ${overlap.join(',')}`,
    );
  const unusedValues = Object.keys(values).filter((v) => !usedValues.has(v));
  if (unusedValues.length)
    throw validation(
      `Value provided in ExpressionAttributeValues unused in expressions: keys: {${unusedValues}}`,
    );
  const unusedNames = Object.keys(names).filter((n) => !usedNames.has(n));
  if (unusedNames.length)
    throw validation(
      `Value provided in ExpressionAttributeNames unused in expressions: keys: {${unusedNames}}`,
    );
  if (!conditionHolds)
    throw awsError(
      'ConditionalCheckFailedException',
      'The conditional request failed',
    );

  const computed = setOps.map(([t, f]) => [t, f(item)]);
  for (const [t, v] of computed) item[t] = v;
  for (const r of removeOps) delete item[r];
  return item;
}

export const DynamoDBDocumentClient = {
  from() {
    return {
      async send(cmd) {
        const i = cmd.input;
        switch (cmd.constructor.name) {
          case 'PutCommand':
            return simulate('DDB.Put', i.Item.imageId, () => {
              assertNoUndefined(i.Item, 'Item');
              state.ddb.set(i.Item.imageId, clone(i.Item));
              return {};
            });
          case 'GetCommand':
            return simulate('DDB.Get', i.Key.imageId, () => ({
              Item: clone(state.ddb.get(i.Key.imageId)),
            }));
          case 'UpdateCommand':
            return simulate('DDB.Update', i.Key.imageId, () => {
              const existing = state.ddb.get(i.Key.imageId);
              // Conditions see an empty item when the key does not exist yet.
              const item = clone(existing) || { ...clone(i.Key) };
              state.ddb.set(
                i.Key.imageId,
                applyUpdate(item, i, existing || {}),
              );
              return i.ReturnValues === 'ALL_NEW'
                ? { Attributes: clone(item) }
                : {};
            });
          default:
            throw new Error(`fake DDB: unsupported ${cmd.constructor.name}`);
        }
      },
    };
  },
};
