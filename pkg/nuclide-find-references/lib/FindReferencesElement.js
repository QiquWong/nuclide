'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type FindReferencesModel from './FindReferencesModel';

import {React, ReactDOM} from 'react-for-atom';
import FindReferencesView from './view/FindReferencesView';

class FindReferencesElement extends HTMLElement {
  _model: FindReferencesModel;

  initialize(model: FindReferencesModel) {
    this._model = model;
    return this;
  }

  getTitle() {
    return 'Symbol References: ' + this._model.getSymbolName();
  }

  // $FlowIssue -- readonly props: t10620219
  attachedCallback(): mixed {
    ReactDOM.render(
      <FindReferencesView model={this._model} />,
      this,
    );
  }

  // $FlowIssue -- readonly props: t10620219
  detachedCallback(): mixed {
    ReactDOM.unmountComponentAtNode(this);
  }
}

export default document.registerElement('nuclide-find-references-view', {
  prototype: FindReferencesElement.prototype,
});
