//
// Get a list of completions we can have, based on the state of the editor.
// Autocompletion happens based on the following factors
// (with increasing relevance):
//
// Level 0 = CSS properties.
// Level 1 = dynamic lookup of available ids.
// Level 2 = static analysis of the code (useful for variables).
//
// Use candidates for UI purposes, and completions when inserting the completion
// in the editor.
//
// Parameters:
//  - source: String of the source code.
//  - caret: Object containing two fields:
//    * line: the line number of the caret, starting with zero.
//    * ch: the column of the caret, starting with zero.
//  - options: Object containing optional parameters:
//    * line: String of the current line (which the editor may provide
//      more efficiently than the default way.
//    * global: global object. Can be used to perform level 1 (see above).
//    * fireStaticAnalysis: A Boolean to run the (possibly expensive) static
//      analysis. Recommendation: run it at every newline.
//
// Return a sorted Completion (see entrance/completers.js).
//  - candidateFromDisplay: Map from display string to candidate.
//  - candidates: A list of candidates:
//    * display: a string of what the user sees.
//    * postfix: a string of what is added when the user chooses this.
//    * score: a number to grade the candidate.
//
function cssCompleter(source, caret, options) {
  options = options || {};
  var completion = new Completion();

  // Getting the context from the caret position.
  var context = getContext(source, caret);
  if (!context) {
    // We couldn't get the context, we won't be able to complete.
    return completion;
  }

  // If it is a property completion, we can do something about it.
  if (context.completing === Completing.property) {
    completion.meld(completeProperties(context.data[0]));
  }

  return completion;
}

exports.css = cssCompleter;


// Autocompletion types.

var Completing = {
  property: 0       // foo { bar|: … }
};

// Get the context.
//
// This uses Tab Atkins' CSS tokenizer.
// See https://github.com/tabatkins/css-parser

// Fetch data from the position of the caret in the source.
// The data is an object containing the following:
//  - completing: a number from the Completing enumeration.
//  - data: information about the context. Ideally, a list of strings.
//
// For example, `foo {bar|` will return
// `{completing:0, data:["bar"]}`.
//
// If we cannot get any contextual information, returns `null`.
//
// Parameters:
//  - source: a string of CSS code.
//  - caret: an objct {line: 0-indexed line, ch: 0-indexed column}.
function getContext(source, caret) {
  var tokens = stripWhitespace(cssCompleter.tokenize(source, {loc:true}));
  if (tokens[tokens.length - 1].loc.end.line < caret.line ||
     (tokens[tokens.length - 1].loc.end.line === caret.line &&
      tokens[tokens.length - 1].loc.end.column < caret.ch)) {
    // If the last token is not an EOF, we didn't tokenize it correctly.
    // This special case is handled in case we couldn't tokenize, but the last
    // token that *could be tokenized* was an identifier.
    return null;
  }

  // At this point, we know we were able to tokenize it.
  // Find the token just before the caret.
  // In order to do that, we use dichotomy.
  var lowIndex = 0;
  var highIndex = tokens.length - 1;
  var tokIndex = (tokens.length / 2) | 0;   // Truncating to an integer.
  var tokIndexPrevValue = tokIndex;
  var lastCall = false;
  var token;
  while (lowIndex <= highIndex) {
    token = tokens[tokIndex];
    // Note: esprima line numbers start with 1, while caret starts with 0.
    if (token.loc.start.line < caret.line) {
      lowIndex = tokIndex;
    } else if (token.loc.start.line > caret.line) {
      highIndex = tokIndex;
    } else if (token.loc.start.line === caret.line) {
      // Now, we need the correct column.
      var range = [
        token.loc.start.column,
        token.loc.end.column
      ];
      if (inRange(caret.ch, range)) {
        // We're done. We've found the token in which the cursor is.
        return contextFromToken(tokens, tokIndex, caret);
      } else if (caret.ch <= range[0]) {
        highIndex = tokIndex;
      } else if (range[1] < caret.ch) {
        lowIndex = tokIndex + 1;
      }
    }
    tokIndex = (highIndex + lowIndex) >>> 1;
    if (lastCall) { break; }
    if (tokIndex === tokIndexPrevValue) {
      tokIndex++;
      lastCall = true;
    } else { tokIndexPrevValue = tokIndex; }
  }
  return contextFromToken(tokens, tokIndex, caret);
};

// Either
//
//  {
//    completing: Completing.<type of completion>,
//    data: <Array of string>
//  }
//
// or undefined.
//
// Parameters:
//  - tokens: list of tokens.
//  - tokIndex: index of the token where the caret is.
//  - caret: {line:0, ch:0}, position of the caret.
function contextFromToken(tokens, tokIndex, caret) {
  var token = tokens[tokIndex];
  var prevToken = tokens[tokIndex - 1];
  if (token.tokenType === "IDENT") {
    if (prevToken) {
      if (prevToken.tokenType === "{" ||
          prevToken.tokenType === ";") {
        // Property completion.
        return {
          completing: Completing.property,
          data: [token.value]
        };
      }
    }
  }
};

function stripWhitespace(tokens) {
  return tokens.filter(function(token) {
    return token.tokenType !== 'WHITESPACE';
  });
}
