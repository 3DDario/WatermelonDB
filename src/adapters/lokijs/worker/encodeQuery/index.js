// @flow
/* eslint-disable no-use-before-define */

import { pipe, always, prop, has, propEq, T, head, length, ifElse } from 'rambdax'

// don't import whole `utils` to keep worker size small
import identical from '../../../../utils/fp/identical'
import objOf from '../../../../utils/fp/objOf'
import cond from '../../../../utils/fp/cond'
import invariant from '../../../../utils/common/invariant'
import likeToRegexp from '../../../../utils/fp/likeToRegexp'

import type { QueryAssociation, SerializedQuery } from '../../../../Query'
import type {
  Operator,
  WhereDescription,
  On,
  And,
  Or,
  Where,
  ComparisonRight,
  Comparison,
  Clause,
  CompoundValue,
} from '../../../../QueryDescription'
import { type TableName, type ColumnName, columnName } from '../../../../Schema'
import type { AssociationInfo } from '../../../../Model'

export type LokiRawQuery = Object | typeof undefined
type LokiOperator =
  | '$aeq'
  | '$eq'
  | '$gt'
  | '$gte'
  | '$lt'
  | '$lte'
  | '$ne'
  | '$in'
  | '$nin'
  | '$between'
  | '$regex'
type LokiKeyword = LokiOperator | '$and' | '$or'

export type LokiJoin = $Exact<{
  table: TableName<any>,
  query: LokiRawQuery,
  originalConditions: Where[], // Needed for column comparisons
  mapKey: ColumnName,
  joinKey: ColumnName,
}>

export type LokiQuery = $Exact<{
  table: TableName<any>,
  query: LokiRawQuery,
  hasJoins: boolean,
}>

const getComparisonRight: ComparisonRight => CompoundValue = (cond([
  [has('value'), prop('value')],
  [has('values'), prop('values')],
  [has('column'), () => invariant(false, 'Column comparisons unimplemented!')], // TODO: !!
]): any)

// TODO: It's probably possible to improve performance of those operators by making them
// binary-search compatible (i.e. don't use $and, $not)
// TODO: We might be able to use $jgt, $jbetween, etc. — but ensure the semantics are right
// and it won't break indexing

type OperatorFunction = CompoundValue => LokiRawQuery

const weakNotEqual: OperatorFunction = value => ({ $not: { $aeq: value } })

const noNullComparisons: OperatorFunction => OperatorFunction = operator => value => ({
  $and: [operator(value), weakNotEqual(null)],
})

const like: OperatorFunction = value => {
  if (typeof value === 'string') {
    return {
      $regex: likeToRegexp(value),
    }
  }

  return {}
}

const notLike: OperatorFunction = value => {
  if (typeof value === 'string') {
    return {
      $and: [{ $not: { $eq: null } }, { $not: { $regex: likeToRegexp(value) } }],
    }
  }

  return {}
}

const operators: { [Operator]: OperatorFunction } = {
  eq: objOf('$aeq'),
  notEq: weakNotEqual,
  gt: objOf('$gt'),
  gte: objOf('$gte'),
  weakGt: objOf('$gt'), // Note: this is correct (at least for as long as column comparisons happens via matchers)
  lt: noNullComparisons(objOf('$lt')),
  lte: noNullComparisons(objOf('$lte')),
  oneOf: objOf('$in'),
  notIn: noNullComparisons(objOf('$nin')),
  between: objOf('$between'),
  like,
  notLike,
}

const encodeComparison: Comparison => LokiRawQuery = ({ operator, right }) => {
  const comparisonRight = getComparisonRight(right)

  if (typeof comparisonRight === 'string') {
    // we can do fast path as we know that eq and aeq do the same thing for strings
    if (operator === 'eq') {
      return { $eq: comparisonRight }
    } else if (operator === 'notEq') {
      return { $ne: comparisonRight }
    }
  }
  return operators[operator](comparisonRight)
}

// HACK: Can't be `{}` or `undefined`, because that doesn't work with `or` conditions
const hackAlwaysTrueCondition: LokiRawQuery = { _fakeAlwaysTrue: { $eq: undefined } }

const encodeWhereDescription: WhereDescription => LokiRawQuery = ({ left, comparison }) =>
  // HACK: If this is a column comparison condition, ignore it (assume it evaluates to true)
  // The column comparison will actually be performed during the refining pass with a matcher func
  has('column', comparison.right)
    ? hackAlwaysTrueCondition
    : objOf(left, encodeComparison(comparison))

const encodeCondition: (QueryAssociation[]) => Clause => LokiRawQuery = associations => clause => {
  switch (clause.type) {
    case 'and':
      return encodeAnd(associations, clause)
    case 'or':
      return encodeOr(associations, clause)
    case 'where':
      return encodeWhereDescription(clause)
    case 'on':
      return encodeJoin(associations, clause)
    case 'loki':
      return clause.expr
    default:
      throw new Error(`Unknown clause ${clause.type}`)
  }
}

const encodeConditions: (
  QueryAssociation[],
) => (Where[]) => LokiRawQuery[] = associations => conditions =>
  conditions.map(encodeCondition(associations))

const encodeAndOr = (op: LokiKeyword) => (
  associations: QueryAssociation[],
  clause: And | Or,
): LokiRawQuery => {
  const conditions = encodeConditions(associations)(clause.conditions)
  // flatten
  return conditions.length === 1 ? conditions[0] : { [op]: conditions }
}

const encodeAnd: (QueryAssociation[], And) => LokiRawQuery = encodeAndOr('$and')
const encodeOr: (QueryAssociation[], Or) => LokiRawQuery = encodeAndOr('$or')

const lengthEq = n =>
  pipe(
    length,
    identical(n),
  )

// Note: empty query returns `undefined` because
// Loki's Collection.count() works but count({}) doesn't
const concatRawQueries: (LokiRawQuery[]) => LokiRawQuery = (cond([
  [lengthEq(0), always(undefined)],
  [lengthEq(1), head],
  [T, objOf('$and')],
]): any)

const encodeRootConditions: (QueryAssociation[]) => (Where[]) => LokiRawQuery = associations =>
  pipe(
    encodeConditions(associations),
    concatRawQueries,
  )

const encodeMapKey: AssociationInfo => ColumnName = ifElse(
  propEq('type', 'belongs_to'),
  always(columnName('id')),
  prop('foreignKey'),
)

const encodeJoinKey: AssociationInfo => ColumnName = ifElse(
  propEq('type', 'belongs_to'),
  prop('key'),
  always(columnName('id')),
)

const encodeJoin = (associations: QueryAssociation[], on: On): LokiRawQuery => {
  const { table, conditions } = on
  const association = associations.find(({ to }) => table === to)
  invariant(
    association,
    'To nest Q.on inside Q.and/Q.or you must explicitly declare Q.experimentalJoinTables at the beginning of the query',
  )
  return {
    $join: {
      table,
      query: encodeRootConditions(associations)((conditions: any)),
      originalConditions: conditions,
      mapKey: encodeMapKey(association.info),
      joinKey: encodeJoinKey(association.info),
    },
  }
}

export default function encodeQuery(query: SerializedQuery): LokiQuery {
  const {
    table,
    description: { where, joinTables, sortBy, take },
    associations,
  } = query

  // TODO: implement support for Q.sortBy(), Q.take(), Q.skip() for Loki adapter
  invariant(!sortBy.length, '[WatermelonDB][Loki] Q.sortBy() not yet supported')
  invariant(!take, '[WatermelonDB][Loki] Q.take() not yet supported')

  return {
    table,
    query: encodeRootConditions(associations)(where),
    hasJoins: !!joinTables.length,
  }
}
