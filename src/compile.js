/**
 * @copyright 2016-present, Andrey Popp <8mayday@gmail.com>
 * @flow
 */

import path from 'path';
import generate from 'babel-generator';
import * as BabelCore from 'babel-core';
import * as types from 'babel-types';
import * as Remark from 'remark';
import traverse from 'babel-traverse';
import * as Babylon from 'babylon';
import mdastVisitNode from 'unist-util-visit';
import mdastToString from 'mdast-util-to-string';
import findPackageJSON from 'find-package-json';

type JSASTComment = {
  value: string;
};
type JSAST = {
  trailingComments: ?Array<JSASTComment>;
};

type Options = $Shape<{
  name: string,
  filename: string
}>;

const REPR_ASSERTION_RE = /^\s*=> /;
const ERR_ASSSERTION_RE = /^\s*([a-zA-Z]*Error): /;

const TESTDOC_SEEN = '__TESTDOC_SEEN';
const RUNTIME = require.resolve('./runtime');
const POLYFILL = require.resolve('babel-polyfill');

const SUPPORTED_LANG = {
  'js+test': true,
  'javasctipt+test': true,
};

export function compile(source: string, options: Options = {}) {

  // Find all code blocks in markdown
  let node = Remark.parse(source);
  let testCaseList = [];
  mdastVisitNode(node, 'code', (node, index, parent) => {
    let prev = parent.children[index - 1];
    let title = null;
    if (prev && prev.type === 'paragraph') {
      title = mdastToString(prev);
    }
    if (title && title[title.length - 1] === ':') {
      title = title.slice(0, title.length - 1);
    }
    if (SUPPORTED_LANG[node.lang]) {
      testCaseList.push({
        title: title,
        lang: node.lang,
        value: node.value
      });
    }
  });

  // Find all assertions within code blocks and generate case and import nodes
  // from them.
  let importList = [];
  let caseList = [];
  testCaseList.forEach(testCase => {
    let src = testCase.value;
    src = `async function testcase() {
      ${src}
    }`;
    let node = Babylon.parse(src, {
      allowImportExportEverywhere: true,
      plugins: ['flow', 'objectRestSpread', 'asyncFunctions'],
    });
    traverse(node, {

      enter(path) {
        let assertion = findAssertion(path.node);
        if (!path.node[TESTDOC_SEEN] && assertion) {
          let nodes;
          if (assertion === 'repr') {
            let {repr} = parseExpectationFromNode(path.node, assertion);
            nodes = stmt`
              __MochaDoctestRuntime.assertRepr(
                ${path.node.expression},
                "${repr}"
              );
            `;
          } else if (assertion === 'error') {
            let {name, message} = parseExpectationFromNode(path.node, assertion);
            nodes = stmt`
              async function dummy() {
                await __MochaDoctestRuntime.assertError(
                  async () => ${path.node.expression},
                  "${name}", "${message}"
                );
              }
            `;
            nodes = nodes.body.body[0];
          }
          // $FlowIssue: ..
          nodes[TESTDOC_SEEN] = true;
          path.replaceWithMultiple(nodes);
        } else if (types.isImportDeclaration(path.node)) {
          importList.push(path.node);
          path.remove();
        }
      }

    });

    caseList = caseList.concat(stmt`
      it(
        "${types.stringLiteral(testCase.title || 'works')}",
        ${caseExpression(node.program.body[0].body.body, {async: true})}
      );
    `);
  });

  // generate program
  let program = [];
  program = program.concat(
    stmt`
      import '${types.stringLiteral(POLYFILL)}';
      import * as __MochaDoctestRuntime from '${types.stringLiteral(RUNTIME)}';
      import assert from 'assert';
    `,
    importList,
    stmt`
      describe(
        "${types.stringLiteral(options.name || options.filename || 'Suite')}",
        ${caseExpression(caseList)}
      );
    `
  );

  let packageJSONCache = {};

  // apply babel transformations
  program = types.program(program);
  program = BabelCore.transformFromAst(program, undefined, {
    babelrc: true,
    filename: options.filename,
    resolveModuleSource(source, filename) {
      let dirname = path.dirname(filename);
      if (packageJSONCache[dirname] === undefined) {
        packageJSONCache[dirname] = findPackageJSON(dirname).next().value || null;
      }
      if (packageJSONCache[dirname] != null) {
        let packageJSON = packageJSONCache[dirname];
        if (source === packageJSON.name) {
          let packageDirname = path.relative(
            dirname,
            path.dirname(packageJSON.__path)
          ) || '.';
          return packageDirname + '/';
        }
        if (source.indexOf(packageJSON.name + '/') === 0) {
          let packageDirname = path.relative(
            dirname,
            path.dirname(packageJSON.__path)
          ) || '.';
          return packageDirname + source.slice(packageJSON.name.length);
        }
      }
      return source;
    }
  }).ast;

  return generate(program).code;
}

function caseExpression(body, options = {async: false}) {
  return types.functionExpression(null, [], types.blockStatement(body), false, options.async);
}

function parseExpectationFromNode(node, assertion) {
  let firstLine = node.trailingComments[0].value;
  let restLines = node.trailingComments.slice(1).map(comment => comment.value.slice(1));
  if (assertion === 'repr') {
    firstLine = firstLine.replace(REPR_ASSERTION_RE, '');
    let repr = [firstLine].concat(restLines).join('\n');
    return {
      repr: types.stringLiteral(repr)
    };
  } else if (assertion === 'error') {
    let name = ERR_ASSSERTION_RE.exec(firstLine)[1];
    let message = firstLine.replace(ERR_ASSSERTION_RE, '');
    message = [message].concat(restLines).join('\n');
    return {
      name: types.stringLiteral(name),
      message: types.stringLiteral(message),
    };
  }
}

function findAssertion(node: JSAST): false | 'repr' | 'error' {
  if (
    types.isExpressionStatement(node) &&
    node.trailingComments &&
    node.trailingComments.length > 0
  ) {
    let firstLine = node.trailingComments[0].value;
    if (REPR_ASSERTION_RE.exec(firstLine)) {
      return 'repr';
    } else if (ERR_ASSSERTION_RE.exec(firstLine)) {
      return 'error';
    } else {
      return false;
    }
  } else {
    return false;
  }
}
