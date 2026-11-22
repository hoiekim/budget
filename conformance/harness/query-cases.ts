/**
 * The ways a route that takes one UUID as a query parameter
 * (`DELETE /budget?id=`, `GET /new-section?parent=`) refuses it, as query
 * strings and the message each gets. Every route built on
 * `requireQueryString` and a `uuid` field check answers these alike.
 */

/** A well-formed id no row has. */
export const NO_SUCH_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

export const uuidQueryCases = (param: string): [query: string, message: string][] => [
  ["", `Missing required parameter: ${param}`],
  ["?other=1", `Missing required parameter: ${param}`],
  [`?${param.toUpperCase()}=${NO_SUCH_ID}`, `Missing required parameter: ${param}`],
  [`?${param}[]=${NO_SUCH_ID}`, `Missing required parameter: ${param}`],
  [`?${param}=${NO_SUCH_ID}&${param}=${NO_SUCH_ID}`, `Parameter ${param} must be a single value, not an array`],
  [`?${param}=&${param}=`, `Parameter ${param} must be a single value, not an array`],
  [`?${param}`, `Parameter ${param} cannot be empty`],
  [`?${param}=`, `Parameter ${param} cannot be empty`],
  [`?${param}=+`, `Parameter ${param} cannot be empty`],
  [`?${param}=%20%09%0A`, `Parameter ${param} cannot be empty`],
  // What JavaScript trims: the no-break space and the byte-order mark too.
  [`?${param}=%C2%A0%EF%BB%BF`, `Parameter ${param} cannot be empty`],
  // The next-line control is not white space to JavaScript.
  [`?${param}=%C2%85`, `Field ${param} must be a uuid`],
  [`?${param}=not-a-uuid`, `Field ${param} must be a uuid`],
  [`?${param}=${NO_SUCH_ID.replace(/-/g, "")}`, `Field ${param} must be a uuid`],
  [`?${param}=%7B${NO_SUCH_ID}%7D`, `Field ${param} must be a uuid`],
  [`?${param}=%20${NO_SUCH_ID}`, `Field ${param} must be a uuid`],
  [`?${param}=${NO_SUCH_ID}%0A`, `Field ${param} must be a uuid`],
  [`?${param}=${NO_SUCH_ID}x`, `Field ${param} must be a uuid`],
  [`?${param}=%zz`, `Field ${param} must be a uuid`],
];
