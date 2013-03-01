// Return a Completion instance, or undefined.
function staticAnalysis(context) {
  var staticCompletion = new Completion();
  var completingIdentifier = (context.completing === Completing.identifier);
  var completingProperty = (context.completing === Completing.property);

  var varName;   // Each will modify this to the start of the variable name.
  var eachProperty = function eachProperty(store, display) {
    if (display.indexOf(varName) == 0
        && display.length > varName.length) {
      // The candidate must match and have something to add!
      staticCompletion.insert(new Candidate(display,
          display.slice(varName.length), store.weight));
    }
  };

  if (completingIdentifier && context.data.length === 1) {
    varName = context.data[0];
    // They have a positive score.
    staticCandidates.properties.forEach(eachProperty);

  } else if (completingIdentifier || completingProperty) {
    var store = staticCandidates;
    for (var i = 0; i < context.data.length - 1; i++) {
      store = store.properties.get(context.data[i]);
      if (!store) { return; }
    }

    varName = context.data[i];
    if (completingProperty) {
      store = store.properties.get(varName);
      if (!store) { return; }
      varName = '';  // This will cause the indexOf check to succeed.
    }
    store.properties.forEach(eachProperty);

    // Seek data from its type.
    if (!!store.type) {
      store = staticCandidates.properties.get(store.type);
      if (!store) { return staticCompletion; }
      store = store.properties.get('prototype');
      if (!store) { return staticCompletion; }
      store.properties.forEach(eachProperty);
    }
  }
  return staticCompletion;
}


// Static analysis helper functions.
//

// Cache in use for static analysis.
var staticCandidates;   // We keep the previous candidates around.



//
// Get all the variables in a JS script at a certain position.
// This gathers variable (and argument) names by means of a static analysis
// which it performs on a parse tree of the code.
//
// Returns a TypeStore object. See below.
// We return null if we could not parse the code.
//
// This static scope system is inflexible. If it can't parse the code, it won't
// give you anything.
//
// Parameters:
// - source: The JS script to parse.
// - caret: {line:0, ch:0} The line and column in the scrip
//   from which we want the scope.
// - options:
//   * store: The object we return. Use to avoid allocation.
//      It is a typeStore, that is, a map from symbol names (as strings) to:
//      - weight: relevance of the symbol,
//      - properties: a typeStore for its properties,
//      - type: a string of the name of the constructor.
//      - func: a string of the function it is the result of.
//   * parse: A JS parser that conforms to
//     https://developer.mozilla.org/en-US/docs/SpiderMonkey/Parser_API
//   * parserContinuation: A boolean. If true, the parser has a callback
//     argument that sends the AST.
//
function updateStaticCache(source, caret, options) {
  options = options || {};
  options.store = options.store || new TypeStore();
  options.parse = options.parse || esprima.parse;

  try {
    if (!!options.parserContinuation) {
      options.parse(source, {loc:true}, function(tree) {
        staticCandidates = getStaticScope(tree, caret, options)
            || staticCandidates;   // If it fails, use the previous version.
      });
    } else {
      var tree = options.parse(source, {loc:true});
      staticCandidates = getStaticScope(tree, caret, options)
          || staticCandidates;   // If it fails, use the previous version.
    }
  } catch (e) { return null; }
}

jsCompleter.updateStaticCache = updateStaticCache;

function getStaticScope(tree, caret, options) {
  var subnode, symbols;
  var store = options.store;

  var node = tree.body;
  var stack = [];
  var index = 0;
  var indices = [];
  var deeper = null;
  do {
    deeper = null;
    for (; index < node.length; index++) {
      subnode = node[index];
      while (["ReturnStatement", "VariableDeclarator", "ExpressionStatement",
              "AssignmentExpression", "Property"].indexOf(subnode.type) >= 0) {
        if (subnode.type == "ReturnStatement") {
          subnode = subnode.argument;
        }
        if (subnode.type == "VariableDeclarator") {
          // Variable names go one level too deep.
          if (subnode.init && subnode.init.type === "NewExpression") {
            store.addProperty(subnode.id.name, subnode.init.callee.name,
                stack.length - 1);
            // FIXME: add built-in types detection.
          } else if (subnode.init && subnode.init.type === "ObjectExpression") {
            typeFromObject(store, [subnode.id.name], subnode.init);
            store.properties.get(subnode.id.name).weight = stack.length - 1;
          } else {
            // Simple object.
            store.addProperty(subnode.id.name, null, stack.length - 1);
          }
          if (!!subnode.init) {
            subnode = subnode.init;
          }
          else break;
        }
        if (subnode.type == "ExpressionStatement") {
          subnode = subnode.expression;  // Parenthesized expression.
        }
        if (subnode.type == "AssignmentExpression") {
          if (subnode.left.type === "MemberExpression") {
            symbols = typeFromMember(store, subnode.left);
          }
          if (subnode.right.type === "ObjectExpression") {
            typeFromObject(store, symbols, subnode.right);
          }
          subnode = subnode.right;       // f.g = function(){…};
        }
        if (subnode.type == "Property") {
          subnode = subnode.value;       // {f: function(){…}};
        }
      }
      if (subnode.type == "FunctionDeclaration" ||
          subnode.type == "FunctionExpression" ||
          // Expressions, eg, (function(){…}());
          (subnode.callee && subnode.callee.type == "FunctionExpression")) {
        if (subnode.callee) {
          subnode = subnode.callee;
        }
        if (subnode.id) {
          store.addProperty(subnode.id.name, 'Function', stack.length);
        }
        if (caretInBlock(subnode, caret)) {
          // Parameters are one level deeper than the function's name itself.
          argumentNames(subnode.params, store, stack.length + 1);
        }
      }
      deeper = nestedNodes(subnode, caret);
      if (!!deeper) {
        // We need to go deeper.
        stack.push(node);
        node = deeper;
        indices.push(index + 1);
        index = 0;
        break;
      } else deeper = null;
    }
    if (!deeper) {
      node = stack.pop();
      index = indices.pop();
    }
  } while (stack.length > 0 || (node && index < node.length) || !!deeper);

  return store;
}

//
// Find a parse node to iterate over, as the node's array.
// Can also return null if it gets unhappy.
//
// Parameters:
// - node: an AST parse tree node.
// - caret: an object {line:0, ch:0} containing the 0-indexed position of the
//   line and column of the caret.
//
function nestedNodes(node, caret) {
  var body = null;
  var newScope = true;  // Whether we enter a new scope.
  if (node.body) {
    if (node.body.body) {
      // Function declaration has a body in a body.
      body = node.body.body;
    } else {
      body = node.body;
    }
  } else if (node.consequent) {
    body = node.consequent.body;  // If statements.
  } else if (node.alternate) {
    body = node.alternate.body;   // If/else statements.
  } else if (node.block) {
    body = node.block.body;       // Try statements.
  } else if (node.handlers) {     // Try/catch.
    body = node.handlers.body.body;
  } else if (node.finalizer) {
    body = node.finalizer.body;   // Try/catch/finally.
  } else if (node.declarations) {
    body = node.declarations;     // Variable declarations.
    newScope = false;
  } else if (node.arguments) {
    body = node.arguments;   // Function calls, eg, f(function(){…});
  } else if (node.properties) {
    body = node.properties;  // Objects, eg, ({f: function(){…}});
  } else if (node.elements) {
    body = node.elements;    // Array, eg, [function(){…}]
  }
  if (!body ||
      // No need to parse a scope in which the caret is not.
      (newScope && !caretInBlock(node, caret))) {
    return null;
  }
  return body;
}

//
// Whether the caret is in the piece of code represented by the node.
//
// Parameters:
//  - node: the parse tree node in which the caret might be.
//  - caret: the line and column where the caret is (both 0-indexed).
//
function caretInBlock(node, caret) {
  // Note that the AST's line number is 1-indexed.
  var astStartLine = node.loc.start.line - 1;
  var astEndLine = node.loc.end.line - 1;
  return (
    // The node starts before the cursor.
    (astStartLine - 1 < caret.line ||
     (astStartLine === caret.line &&
      node.loc.start.column <= caret.ch)) &&
    // The node ends after the cursor.
    (caret.line < astEndLine ||
     (astEndLine === caret.line &&
      caret.ch <= node.loc.end.column)));
}

//
// Get the argument names of a function.
//
// Parameters:
// - node: the "params" property of a FunctionExpression.
// - store: a Map where we store the information that an identifier exists and
//   has the given weight.
// - weight: an integer measure of how deeply nested the node is. The deeper,
//   the bigger.
//
function argumentNames(node, store, weight) {
  for (var i = 0; i < node.length; i++) {
    store.addProperty(node[i].name, null, weight);
  }
}



//
// Type inference.

// A type inference instance maps symbols to an object of the following form:
//  - weight: relevance of the symbol,
//  - properties: a Map from property symbols to typeStores for its properties,
//  - type: a string of the name of the constructor.
//  - func: if true, the type given is actually the name of the function whose
//    call returned the object.
//    FIXME: use this information to assume that all elements returned from this
//    function have the same property.
function TypeStore(type, weight, func) {
  this.properties = new Map();
  this.type = type || "Object";
  this.weight = weight || 0;
  this.func = !!func;
}

TypeStore.prototype = {
  addProperty: function(symbol, type, weight, func) {
    if (!this.properties.has(symbol)) {
      this.properties.set(symbol, new TypeStore(type, weight, func));
    } else {
      // The weight is proportional to the frequency.
      this.properties.get(symbol).weight++;
    }
  }
};

// Store is a TypeStore instance,
// node is a MemberExpression.
function typeFromMember(store, node) {
  var symbols, symbol, i;
  symbols = [];
  symbol = '';
  while (node.object.type !== "Identifier" &&
         node.object.type !== "ThisExpression") {
    symbols.push(node.property.name);
    node = node.object;
  }
  symbols.push(node.property.name);
  if (node.object.type !== "ThisExpression") {
    symbols.push(node.object.name);  // At this point, node is an identifier.
  } else {
    symbols.push("this");
  }

  // Now that we have the symbols, put them in the store.
  // FIXME: use some type information.
  symbols.reverse();
  for (i = 0; i < symbols.length; i++) {
    symbol = symbols[i];
    store.addProperty(symbol);
    store = store.properties.get(symbol);
  }
  return symbols;
}

// Store is a TypeStore instance,
// node is a ObjectExpression.
function typeFromObject(store, symbols, node) {
  var property, i, substore, nextSubstore;
  substore = store;
  // Find the substore insertion point.
  for (i = 0; i < symbols.length; i++) {
    nextSubstore = substore.properties.get(symbols[i]);
    if (!nextSubstore) {
      // It really should exist.
      substore.addProperty(symbols[i]);
      nextSubstore = substore.properties.get(symbols[i]);
    }
    substore = nextSubstore;
  }
  // Add the symbols.
  for (i = 0; i < node.properties.length; i++) {
    property = node.properties[i];
    substore.addProperty(
        property.key.name? property.key.name
                         : property.key.value);
  }
}
