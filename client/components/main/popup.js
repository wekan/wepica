import { BlazeComponent } from 'meteor/peerlibrary:blaze-components';
import { Template } from 'meteor/templating';

const PopupBias = {
  Before: Symbol("S"),
  Overlap: Symbol("M"),
  After: Symbol("A"),
  Fullscreen: Symbol("F"),
  includes(e) {
    return Object.values(this).includes(e);
  }
}

// this class is a bit cumbersome and could probably be done simpler.
// it manages two things : initial placement and sizing given an opener element,
// and then movement and resizing. one difficulty was to be able, as a popup
// which can be resized from the "outside" (CSS4) and move from the inside (inner
// component), which also grows and shrinks frequently, to adapt.
// I tried many approach and failed to get the perfect fit; I feel that there is
// always something indeterminate at some point. so the only drawback is that
// if a popup contains another resizable component (e.g. card details), and if
// it has been resized (with CSS handle), it will lose its dimensions when dragging
// it next time.
class PopupDetachedComponent extends BlazeComponent {
  onCreated() {
    Object.assign(this, this.data());

    if (typeof(this.closeDOMs) === "string") {
      // helper for passing arg in JADE template
      this.closeDOMs = this.closeDOMs.split(';');
    }

    // The popup's own header, if it exists
    this.closeDOMs.push("click .js-close-detached-popup");
    // Also try to be smart...
    this.closeDOMs.push("click .js-close");

    // Custom hook
    this.afterCreated?.(this);
    if (this.customAutorun) {
      this.autorun(() => {
        this.customAutorun(this);
      });
    }
  }

  // Main intent of this component is to have a modular popup with defaults:
  // - sticks to its opener while being a child of body (thus in the same stacking context, no z-index issue)
  // - is responsive on shrink while keeping position absolute
  // - can grow back to initial position step by step
  // - exposes various sizes as CSS variables so each rendered popup can use them to adapt defaults
  // * issue is that it is done by hand, with heurisitic/simple algorithm from my thoughts, not sure it covers edge cases
  // * however it works well so far and maybe more "fixed" element should be popups
  onRendered() {
    this.popup = this.firstNode();
    // So we can bind "this" when handling events, especially for afterConfirm-ish
    this.openerComponent = BlazeComponent.getComponentForElement(this.openerElement);

    const popupStyle = window.getComputedStyle(this.firstNode());
    // margin may be in a relative unit, not computable in JS, but we get the actual pixels here
    this.popupMargin = parseFloat(popupStyle.getPropertyValue("--popup-margin"), 10) || Math.min(window.innerWidth / 50, window.innerHeight / 50);

    this.draw();
    // popups resize often, better follow them by default;
    this.innerElement = this.find('.content');
    this.observers = [this.follow(), this.resize()];

    $(window).on('resize', () => {
      this.minimize();
      this.draw();
    });

    this.afterRendered?.(this);
  }

  draw() {
    if (!this.isRendered()) {return}
    if (!this.initialWidthRatio || !this.initialHeightRatio) {
      // Enables us to shrink when window goes little then big
      // Othewise no easy way to know; easier to get shrinked
      const maxDims = this.computeMaxDims();
      this.initialWidthRatio = maxDims.width / window.innerWidth;
      this.initialHeightRatio = maxDims.height / window.innerHeight;
      this.referenceWidth = maxDims.width;
      this.referenceHeight = maxDims.height;
      this.initialWindowWidth = window.innerWidth;
      this.initialWindowHeight = window.innerHeight;

      // Unless required explicitely, small popups without headers will try harder to stay close to their opener
      // on window resizes, even if it would put them out of sight. This also implies absolute rather that fixed positionning.
      if (!this.showHeader && this.sticky !== false && (this.initialWidthRatio < 0.2 || this.initialHeightRatio < 0.2 )) {
        this.sticky = true;
      }
    }

    // In practice, this should only influence the positionning of the popup and its
    // ability to be rendered off-screen. The sizing is done regarding the unconstraigned
    // popup size within its current context, so if it depends on viewport-related units,
    // a smaller viewport means a smaller popup, even if it sticks to its parent.
    if (this.sticky) {
      this.referenceViewportWidth = this.initialWindowWidth;
      this.referenceViewportHeight = this.initialWindowHeight;
    } else {
      this.referenceViewportWidth = window.innerWidth;
      this.referenceViewportHeight = window.innerHeight;
    }

    for (const e of [$(this.popup), $(this.innerElement)]) {
      e.css('width', '');
      e.css('height', '');
    }

    this.dims(this.computePopupDims());
    this.toFront();
  }

  margin() {
    return this.popupMargin;
  }

  handleSelectors() {
    let selectors = []
    // We do not manage dragging without our own header
    if (this.showHeader) {
      selectors.push(Utils.isMiniScreen() ? '.js-popup-drag-handle' : '.header-title');
    }
    if (this.handleDOM) {
      selectors.push(this.handleDOM);
    }
    return selectors;
  }

  ensureHandling(dims) {
    // this makes sure that at least one known possibility to move the popup is rendered on screen
    // while moving the popup. it seems a bit niche but think about dragging anything below the
    // adress bar. for other cases, `offLimits` should be used to decide.
    // 💡 this has been done as a quick POC; probably stuff like intersection observers would do a better job
    // also at first, the function was much more elaborate, trying to handle cases with multiple handles and so
    // on, but they probably do not exist or are not worth the complexity. so the below code will work a bit less
    // well for multiple handle elements.
    // the popup dims difference for candidates
    const deltaX = dims.left - this.dims().left;
    const deltaY = dims.top - this.dims().top;

    for (const sel of this.handleSelectors()) {
      const {left, top, width, height} = this.find(sel).getBoundingClientRect();
      const handleX = left + deltaX;
      const handleY = top + deltaY;
      // count size when going left or top so the popup is not constrained as a whole in that direction
      if (handleX + width / 5 + this.margin() > window.innerWidth) { dims.left = window.innerWidth - width / 5 - this.margin() + window.scrollX}
      // not symetrical because we shift from the left point
      if (handleX + 4*width/5 - this.margin() < 0) {dims.left = -4*width/5 + this.margin() + window.scrollX}
      if (handleY + height/5 + this.margin() > window.innerHeight) { dims.top = window.innerHeight - height/5 - this.margin() + window.scrollY}
      if (handleY + 4*height/5 - this.margin() < 0) {dims.top = -4*height/5 + this.margin() + window.scrollY}
    }

    return dims;
  }

  moving() {
    return $(this.popup).hasClass('is-moving');
  }

  ensureDimsLimit(dims) {
    // boilerplate to try to make sure that popup visually fits
    // ⚠️ a previous version tried to make the popup shrink to fit screen.
    // conclusion is that better let it be offscreen and let user decide: I feel
    // that in most cases, we cannot take a good average decision without
    // even knowing the type of popup content, and it happens not so often.
    // 💡 however, now that popup width and height and re-evaluated on viewport resizes,
    // this has even less reasons to stay there.
    let { left, top, width, height } = dims;
    if (!this.offLimits) {
      // once size is settled at best, ultimately prevent to popup to go offscreen
      if (left - window.scrollX + width > this.referenceViewportWidth) { left = this.referenceViewportWidth - width + window.scrollX; }
      if (top - window.scrollY + height > this.referenceViewportHeight) { top = this.referenceViewportHeight - height + window.scrollY; }
    }
    // let left/top be negative so caller has a hint that popup does not fits at all
    return { left, top, width, height }
  }

  dims(newDims) {
    if (!this.isRendered() || this.isDestroyed()) {return}
    if (!this.popupDims) {
      this.popupDims = {};
    }
    if (newDims) {
      let curDims = this.dims();
      // be sure to have all variables set, taking available ones if undefined
      Object.assign(curDims, newDims);
      newDims = this.ensureDimsLimit(curDims);
      if (!this.offLimits) {
          // if at this stage, popup cannot fit at all, go fullscreen
          if (newDims.left < window.scrollX && newDims.top < window.scrollY && !this.moving()) {
          this.maximize();
          return;
        }
        if (newDims.left < window.scrollX) { newDims.left = window.scrollX; }
        if (newDims.top < window.scrollY) { newDims.top = window.scrollY; }
      }
      if (this.moving()) {
        // ensure all handles are not off-screen and could not be brought can when moving
        // if not moving, could be because of stickiness or other things;
        // do not be super-constraintful by default
        newDims = this.ensureHandling(newDims);
      }

      for (const e of Object.keys(newDims)) {
        let value = parseFloat(newDims[e]);
          if (!isNaN(value)) {
            $(this.popup).css(e, `${value}px`);
            this.popupDims[e] = value;
          }
        }
      }
    // avoid bad things happening to the original object
    return structuredClone(this.popupDims);
  }

  maximize() {
    if (!this.fullscreen) {
      this.fullscreen = true;
      $(this.popup).addClass('popup-fullscreen');
      this.draw();
    }
  }

  minimize() {
    if (this.fullscreen) {
      this.fullscreen = false;
      $(this.popup).removeClass('popup-fullscreen');
      this.draw();
    }
  }

  follow() {
    return new ResizeObserver((_) => {
      if (!this.isRendered() || this.isDestroyed()) {
        // prevent edge case where e.g. popup opener is removed from DOM on window resizes,
        // but observers are not immediately disconnected but do not refer to in the DOM etc
        for (const o of this.observers) {
          if (o) {o.disconnect()};
        }
        return;
      }
      if (this.moving()) {return}
      if (this.fullscreen) {return}
      const width = this.innerElement.scrollWidth;
      const height = this.innerElement.scrollHeight + (this.find('.header')?.offsetHeight || 0);
      // we don't want to run this during eg. dragging or resizing
      if (!this.pointerDown) {
        // otherwise, I tried a lot of ways, but it seems to me there is no way of be absolutely sure
        // that popups won't loop-overflow. an "ignore amount" of size change would sometimes be too much or too little.
        // capping to initial intrinsic size won't capture new nodes inserted, possibly, by slow reactivity.
        // and so on. but as per the state of the component, it seems that there is no more such loops.

        this.dims({ width, height});
      }
    }).observe(this.innerElement);
  }

  resize() {
    return new ResizeObserver((_) => {
      // only acceptable case to mess around with size in addition to the other observer,
      // i.e. the case where CSS resize is active. in changes inline style and we
      // want to keep the information, or it will be lost at the next computation
      if (this.pointerDown && !this.moving()) {
        const cssWidth = parseFloat($(this.popup).css('width'));
        const cssHeight = parseFloat($(this.popup).css('height'));
        this.dims({width: cssWidth, height: cssHeight});
        this.referenceWidth = cssWidth;
        this.referenceHeight = cssHeight;
        // so we know we should "lie" about natural intrinsic size
        this.cssResized = true;
      }
    }).observe(this.popup);
  }

  currentZ(z = undefined) {
    if (z === undefined) {
      return this.popup.style.zIndex || 0;
    }
    if (!z || isNaN(z) ||z === Infinity || z === -Infinity) {
      z = 1;
    }
    // relative, add a constant to be above root elements
    this.popup.style.zIndex = parseInt(z) + 10;
    this.popup.style.zIndex - 10;
  }

  toFront() {
    if (!this.isRendered() || !this.firstNode()) {return}
    this.currentZ(Math.max(...PopupComponent.stack.map(p => p.outerComponent.currentZ())) + 1);
    this.afterToFront?.(this);
  }

  toBack() {
    if (!this.isRendered() || !this.firstNode()) {return}
    this.currentZ(Math.min(...PopupComponent.stack.map(p => p.outerComponent.currentZ())) + 1);
  }

  destroy(userClose) {
    this.controlComponent.destroy(false, userClose);
  }

  events() {
    let closeEvents = {};
    this.closeDOMs?.forEach((e) => {
      closeEvents[e] = (event) => {
        // make sure that we are really the target, just in case; popup can be
        // really frustrating when not behaving as expected
        if (PopupComponent.findParentPopup(event.target) === this) {
          this.destroy(true);
        }
      }
    })

    const miscEvents = {
      'click .js-confirm'(e) {
        if (this.afterConfirm) {
          // as the popup stack is a bit more flexible, you can get events
          // from popups at the bottom; it is possible to find back their
          // popup component eg. to destroy them, but just add it to
          // the event; probably a bit dirty but also more deterministic.s
          // Here, the caller can choose what will be "this" in the callback;
          // default to the component which triggered opening of popup, to ease retrocompatibility
          const args = Object.assign(this.confirmArgs ?? {}, {popup: this.controlComponent});
          // the original behaviour is to have data of opener as this
          this.afterConfirm.call(this.whatsThis ?? Blaze.getData(this.openerView), e, args);
        }
      },
      // bad heuristic but only for best-effort UI
      // narrowed down to popup with headers for now
      'pointerdown .pop-over .header'() {
        // Useful to do it now in case of dragging
        this.toFront();
        this.pointerDown = true;
      },
      'pointerup .pop-over .header'() {
        this.pointerDown = false;
      }
    };

    const movePopup = (event) => {
      event = event.originalEvent;
      // Ignore right-ish clicks
      if (!(event.isPrimary && (event.pointerType !== 'mouse' || event.button === 0))) {
        return;
      }
      event.preventDefault();
      const deltaHandleX = this.dims().left - event.pageX;
      const deltaHandleY = this.dims().top - event.pageY;
      $(this.popup).addClass('is-moving');
      this.minimize();

      const onPointerMove = (e) => {
        // previously I used to resize popup when reaching border but it's a so bad idea, triggers loop
        // with other resizing/moving mechanisms, and is probably bad in terms of UI.
        // only interest was maybe on mobile where there is no CSS resize
        this.dims({ left: e.pageX + deltaHandleX, top: e.pageY + deltaHandleY });

        if (this.popup.scrollY) {
          this.popup.scrollTo(0, 0);
        }
      };

      const onPointerUp = (event) => {
        $(document).off('pointermove', onPointerMove);
        $(document).off('pointerup', onPointerUp);
        $(this.popup).removeClass('is-moving');
      };

      if (Utils.shouldIgnorePointer(event)) {
        onPointerUp(event);
        return;
      }

      $(document).on('pointermove', onPointerMove);
      $(document).on('pointerup', onPointerUp);
    };

    for (const handle of this.handleSelectors()) {
      miscEvents[`pointerdown ${handle}`] = (e) => movePopup(e);
    }
    return super.events().concat(closeEvents).concat(miscEvents);
  }

  computeMaxDims() {
    if (!this.isRendered()) {return;}
    if (this.cssResized && !this.fullscreen) {return {width: this.referenceWidth, height: this.referenceHeight}}
    // Get size of inner content, even if it overflows
    const content = this.find('.content');
    let popupHeight = content?.scrollHeight;
    let popupWidth = content?.scrollWidth;
    if (this.showHeader) {
      const headerRect = this.find('.header');
      popupHeight += headerRect.scrollHeight;
      popupWidth = Math.max(popupWidth, headerRect.scrollWidth)
    }
    // some popups go naturally really wide because of inner text. make an exception for those and lie
    let width = Math.max(popupWidth, $(this.popup).width());
    let height = Math.max(popupHeight, $(this.popup).height());
    if (height < window.innerHeight / 4 && width > Math.min(500, 4 * window.innerWidth / 5)) {
      width = Math.min(300, window.innerWidth / 3);
      $(this.popup).css('width', `${width}px`);
      height = $(this.popup).height();
    }
    return { width, height };
  }

  placeOnSingleDimension(elementLength, openerPos, openerLength, maxLength, biases, n) {
    // avoid too much recursion if no solution
    if (!n) {
      n = 0;
    }
    if (n >= 5) {
      // if we exhausted a bias, remove it
      n = 0;
      biases.pop();
      if (biases.length === 0) {
        return -1;
      }
    } else {
      n += 1;
    }

    if (!biases?.length) {
      const cut = maxLength / 3;

      if (openerPos < cut) {
        // Corresponds to the default ordering: if element is close to the axe's start,
        // try to put the popup after it; then to overlap; and give up otherwise.
        biases = [PopupBias.After, PopupBias.Overlap]
      }
      else if (openerPos > 2 * cut) {
        // Same idea if popup is close to the end
        biases = [PopupBias.Before, PopupBias.Overlap]
      }
      else {
        // If in the middle, try to overlap: choosing between start or end, even for
        // default, is too arbitrary; a custom order can be passed in argument.
        biases = [PopupBias.Overlap]
      }
    }
    // Remove the first element and get it
    const bias = biases.splice(0, 1)[0];

    let factor;
    const openerRef = openerPos + openerLength / 2;
    if (bias === PopupBias.Before) {
      factor = 1;
    }
    else if (bias === PopupBias.Overlap) {
      factor = openerRef / maxLength;
    }
    else {
      factor = 0;
    }

    let candidatePos = openerRef - elementLength * factor;
    const deltaMax = candidatePos + elementLength - maxLength;
    if (candidatePos < 0 || deltaMax > 0) {
      if (deltaMax <= 2 * this.margin()) {
        // if this is just a matter of margin, try again
        // useful for (literal) corner cases
        biases = [bias].concat(biases);
        openerPos -= 5;
      }
      if (biases.length === 0) {
        // we could have returned candidate position even if the size is too large, so
        // that the caller can choose, but it means more computations and edge cases...
        // any negative means fullscreen overall as the caller will take the maximum between
        // margin and candidate.
        return -1;
      }
      return this.placeOnSingleDimension(elementLength, openerPos, openerLength, maxLength, biases, n);
    }
    return candidatePos;
  }

  computePopupDims() {
    if (!this.isRendered?.()) {
      return;
    }

    // Coordinates of opener related to viewport
    let { x: parentX, y: parentY } = this.nonPlaceholderDims;
    let { height: parentHeight, width: parentWidth } = this.nonPlaceholderDims;

    const maxDims = this.computeMaxDims();
    let popupHeight = maxDims.height;
    let popupWidth = maxDims.width;

    // fullscreen have priority over stickiness, thus the use of window.innerX there
    // 🚧 experiment: remove isMiniScreen() check; let popups be fullscreen anywhere
    // (prefer let the people who design stuff choose)
    // 💡 using the reference dims makes the popup go fullscreen when window shrinks,
    // even if it shrinked because of resize observer or CSS rules
    if (this.fullscreen || (this.referenceWidth >= 4 * window.innerWidth / 5 && this.referenceHeight >= 4 * window.innerHeight / 5)) {
      // Go fullscreen!
      popupWidth = window.innerWidth;
      // Avoid address bar (trick: https://stackoverflow.com/questions/61297303/get-max-available-browser-height-without-browser-toolbar-javascript)
      popupHeight = document.documentElement.clientHeight || window.innerHeight - 100;
      this.fullscreen = true;
      $(this.popup).addClass('popup-fullscreen');
      return ({
        width: window.innerWidth,
        height: window.innerHeight,
        left: 0,
        top: 0,
      });
    } else {
      $(this.popup).removeClass('popup-fullscreen');
      let maxHeight = this.referenceViewportHeight - this.margin() * 2;
      let maxWidth = this.referenceViewportWidth - this.margin() * 2;
      let biasX, biasY;
      if (Utils.isMiniScreen()) {
        // On mobile I found that being able to close a popup really close from where it has been clicked
        // is comfortable; so given that the close button is top-right, we prefer the position of
        // popup being right-bottom, when possible. We then try every position, rather than choosing
        // relatively to the relative position of opener in viewport
        biasX = [PopupBias.Before, PopupBias.Overlap, PopupBias.After];
        biasY = [PopupBias.After, PopupBias.Overlap, PopupBias.Before];
      }

      let candidateX, candidateY;
      if (!this.moving()) {
        // switching from fixed positionning to absolute positionning is better for UX, but we must act with
        // extra care. indeed, most of the computations there are done with bounding boxes, so coordinates related to viewport.
        // as long as we only go this way (computations to inline style), everything is fine.
        // if for any reason, one would want to get top/left from inline style to compute something in this class,
        // they would probably face jumps and other glitches which, I believe, cannot be solved easily.
        candidateX = this.placeOnSingleDimension(popupWidth, parentX, parentWidth, maxWidth, biasX) + window.scrollX;
        candidateY = this.placeOnSingleDimension(popupHeight, parentY, parentHeight, maxHeight, biasY) + window.scrollY;
      } else {
        // current X, Y will be used. we don't want to take the popup back to its opener when
        // moving it.
      }

      // during initial placement we constrain the size once.
      // then, fitting the screen it is not enforced until redrawn.
      // this is mostly cosmetic as we don't even check for overflowing;
      // but in the event one dimension is filled, at least it would have initial margin.
      if (popupHeight + 2 * this.margin() > this.referenceViewportHeight) {
        popupHeight = this.referenceViewportHeight - 2 * this.margin();
        candidateY = window.scrollY + this.margin();
      }
      if (popupWidth + 2 * this.margin() > this.referenceViewportWidth) {
        popupWidth = this.referenceViewportWidth - 2 * this.margin();
        candidateX = window.scrollX + this.margin();
      }

      return ({
        width: popupWidth,
        height: popupHeight,
        left: candidateX,
        top: candidateY,
      });
    }
  }

  colorClass() {
    return Utils.getColorClass();
  }
}

class PopupComponent extends BlazeComponent {
  static stack = [];
  // good enough as long as few occurences of such cases
  static nonUniqueWhitelist = ["cardDetails"];


  static refresh(popups = PopupComponent.stack) {
    // re-render a popup : too complicated to render only inner part, way safer
    // to re-render all the component and view, and destroying everything before;
    // reactivity is maintained. a list a popup to re-render can be given.
    for (const p of PopupComponent.stack.filter(e => popups.includes(e))) {
      let args = p.data();
      p.destroy();
      PopupComponent.open(args);
    }
  }
  // to provide compatibility with Popup.open().
  static open(args) {
    const openerView = Blaze.getView(args.openerElement);
    if (!openerView) {
      console.warn(`no parent found for popup ${args.name}, attaching to body: this should not happen.`);
      return;
    }


    // render ourselves; everything is automatically managed from that moment, we just added
    // a level of indirection but this will not interfere with data
    const popup = new PopupComponent();
    Blaze.renderWithData(
      popup.renderComponent(BlazeComponent.currentComponent()),
      args,
      args.openerElement,
      null,
      openerView
    );
    return popup;
  }

  static destroy(renderParent) {
    PopupComponent.stack.at(-1)?.destroy(renderParent);
  }

  static findParentPopup(element) {
    return BlazeComponent.getComponentForElement($(element).closest('.pop-over')[0]);
  }

  static findPopupById(popupId) {
    return PopupComponent.stack.filter(e => e._id === popupId);
  }

  static findPopupByName(popupName) {
    return PopupComponent.stack.filter(e => e.name === popupName);
  }

  static draw(event) {
    const popup = PopupComponent.findParentPopup(event.target);
    popup?.draw();
    return popup;
  }

  static toFront(event) {
    const popup = PopupComponent.findParentPopup(event.target)
    popup?.toFront();
    return popup;
  }

  static toBack(event) {
    const popup = PopupComponent.findParentPopup(event.target);
    popup?.toBack();
    return popup;
  }

  static maximize(event) {
    const popup = PopupComponent.findParentPopup(event.target);
    popup?.toFront();
    popup?.maximize();
    return popup;
  }

  static minimize(event) {
    const popup = PopupComponent.findParentPopup(event.target);
    popup?.minimize();
    return popup;
  }


  getOpenerElement(view) {
    // Look for the first parent view whose first DOM element is not virtually us
    const firstNode = $(view.firstNode());

    // The goal is to have the best chances to get the element whose size and pos
    // are relevant; e.g. when clicking on a date on a minicard, we don't wan't
    // the opener to be set to the minicard.
    // In order to work in general, we need to take special situations into account,
    // e.g. the placeholder is isolated, or does not have previous node, and so on.
    // In general we prefer previous node, then next, then any displayed sibling,
    // then the parent, and so on.
    let candidates = [];
    if (!firstNode.hasClass(this.popupPlaceholderClass())) {
      candidates.push(firstNode);
    }
    candidates = candidates.concat([firstNode.prev(), firstNode.next()]);
    const otherSiblings = Array.from(firstNode.siblings()).filter(e => !candidates.includes(e));

    for (const cand of candidates.concat(otherSiblings)) {
      const displayCSS = cand?.css("display");
      if (displayCSS && displayCSS !== "none") {
        return cand[0];
      }
    }
    return this.getOpenerElement(view.parentView);
  }

  getParentData(view) {;
    let data;
    // ⚠️ node can be a text node
    while (view.firstNode?.()?.classList?.contains(this.popupPlaceholderClass())) {
      view = view.parentView;
      data = Blaze.getData(view);
    }
    // This is VERY IMPORTANT to get data like this and not with templateInstance.data,
    // because this form is reactive. So all inner popups have reactive data, which is nice
    return data;
  }

  onCreated() {
    // use the data ._id or a random number to identify the popup.
    // this heuristic works in general cases; for future edge cases, add to the whitelist.
    const dataId = this.parentComponent?.()?.data?.()?._id;
    this._id = dataId ?? String(Math.floor(Math.random() * 10000));
    const isoPopup = dataId ? PopupComponent.findPopupById(dataId) : PopupComponent.findPopupByName(this.name);
    // refuse to open multiple popup with same name and no ID or same name and same ID;
    // default is to destroy the old one and re-render the new one, as it should
    // better reflect stuff this programmatic moves.
    if (isoPopup.length > 0 && !PopupComponent.nonUniqueWhitelist.includes(this.name)) {
      // 💡 here, we could change the behaviour. possibilities are:
      // 1. destroy existing popup and let the current one open
      // 2. destroy new popup and
      //    a. do nothing
      //    b. force re-rendering of existing popup
      //    c. bring other popup to front (b. includes c.)
      // ...
      for (const popup of isoPopup) {
        popup.destroy();
      }
    }

    // All of this, except name, is optional. The rest is provided "just in case", for convenience.
    // Indeed, the heuristics that I tried seem to adapt to the new similar popups I discovered later. But this list grew and grew because
    // each time I added the possibility to override the behaviour I tweaked by default for some popups characteristics.
    //
    // - name is the name of a template to render inside the popup (to the detriment of its size) or the contrary
    // - showHeader can be turned off if the inner content always have a header with buttons and so on
    // - title is shown when header is shown
    // - miscOptions is for compatibility
    // - closeDOMs can be used alternatively; it is an array of "<event> <selector>" to listen that closes the popup.
    //   if header is shown, closing the popup is already managed. selector is relative to the inner template (same as its event map)
    // - handleDOM is an element who can be clicked to move popup
    //   it is useful when the content can be redimensionned/moved by code or user; we still manage events, resizes etc
    //   but enables inner elements or handles to automatically make the popup move on pointer "drag".
    // - afterConfirm is a function to call after a click on `.js-confirm`, similar to the base popup system; whatThis is an optional object to pass as `this` when calling the function; confirmArgs is an object whose properties will be assigned to whatThis.
    // - offLimits is a boolean enabling even non-sticky popups to go off the viewport limits, e.g. on handling,
    //   even if it would send the popup out of viewport.this is useful for contextual popups which feels odd when far.
    //   ❓ so far I assumed a global "no" but at the end it may be a source of frustration for users with little benefit, so I added this options
    //   and set it to true. future devs can override this globally there, or locally for some popups.
    //   far from their opener, like the one to add a new card.
    //   💡 the only "absolute" defaut for now is that we prevent the handle region
    //   to go completely offscreen, which would make the popup unrecoverable without closing it.
    // - sticky is a boolean which will bias the popup towards to stick to its parent on resizing.
    //   💡 if no explicit boolean is given, as a good enough hint (I hope so), popups without headers are
    //   considered more "tied" to their opener than the others, and are made sticky by default.
    //   ⚠️ fixed popups are less convenient but at least stay on screen; if my code has bug, and a form was being filled,
    //   window is resized, and popup is gone (visually), users could lose draft data.
    // - onCreated, onRendered and onDestroyed can be hooked with the eponym args; they will be called at the end of the components'. ❗ this is passed as first arg, autorun is handle additionnally to onCreated
    const data = this.data();
    this.popupArgs = {
      _id: this._id,
      name: data.name,
      showHeader: data.showHeader ?? true,
      title: data.title,
      openerElement: data.openerElement,
      closeDOMs: data.closeDOMs ?? [],
      handleDOM: data.handleDOM,
      afterCreated: data.onCreated,
      afterRendered: data.onRendered,
      afterDestroyed: data.onDestroyed,
      afterToFront: data.toFront,
      customAutorun: data.autorun,
      offLimits: data.offLimits ?? true,
      sticky: data.sticky ?? null,
      forceData: data.miscOptions?.dataContextIfCurrentDataIsUndefined || data.forceData,
      afterConfirm: data.miscOptions?.afterConfirm,
      whatsThis: data.miscOptions?.whatsThis,
      confirmArgs: data.confirmArgs,
      controlComponent: this,
    }
    this.name = this.data().name;

    this.innerTemplate = Template[this.name];
    this.innerComponentClass = BlazeComponent.getComponent(this.name);
    this.outerComponentClass = BlazeComponent.getComponent('popupDetached');
    if (!(this.innerComponentClass || this.innerTemplate)) {
      throw new Error(`template and/or component ${this.name} not found`);
    }

    // We close a potential opened popup on any left click on the document, or go
    // one step back by pressing escape.
    for (const action of ['back', 'close']) {
      const self = this;
      EscapeActions.register(
        // hard-coded in escapeActions.js
        `popup-${action}`,
        () => self.destroy,
        // For clicks, only trigger escape when click is outside any popup
        (target) => {
          if (!target) {return PopupComponent.stack.length > 0}
          return !PopupComponent.findParentPopup();
        },
      );
    }
    // Child popups will register so closing can cascade
    // However they won't probably because of the unorthodox DOM stuff
    // Theorically only one child is possible because popups are all siblings
    this.children = [];
    const parentCandidate = PopupComponent.findParentPopup(this.popupArgs.openerElement);
    if (parentCandidate) {
      parentCandidate.controlComponent.children.push(this);
    }
  }

  popupPlaceholderClass() {
    return "popup-placeholder";
  }

  render() {
    // see below for comments
    this.outerView = Blaze.renderWithData(
      // data is passed through the parent relationship
      // we need to render it again to keep events in sync with inner popup
      this.outerComponentClass.renderComponent(this.component()),
      this.popupArgs,
      document.body,
      null,
      this.openerView
    );

    const popupContentNode = this.outerView.firstNode?.()?.getElementsByClassName('content')?.[0];
    // we really want to avoid zombies popups
    if (!popupContentNode) {
      console.warn('detached popup could not render; content div not found');
      this.destroy();
    }

    this.innerView = Blaze.renderWithData(
      // the template to render: either the content is a BlazeComponent or a regular template
      // if a BlazeComponent, render it as a template first
      this.innerComponentClass?.renderComponent?.(this.component()) || this.innerTemplate,
      // dataContext used for rendering: each time we go find data, because it is non-reactive
      () => (this.popupArgs.forceData || this.getParentData(this.currentView)),
      // DOM parent: ask to the detached popup, will be inserted at the last child
      popupContentNode,
      // "stop" DOM element; we don't use
      null,
      // important: this is the Blaze.View object which will be set as `parentView` of
      // the rendered view. we set it as the parent view, so that the detached popup
      // can interact with its "parent" without being a child of it, and without
      // manipulating DOM directly.
      this.openerView
    );

    // Get concrete instances instead of classes
    this.outerComponent = BlazeComponent.getComponentForElement(this.outerView.firstNode?.());
    this.outerComponent.draw();

    // firstNode sometimes returns a text node; children return only Element.
    const candidateInnerComponent = BlazeComponent.getComponentForElement(popupContentNode.children[0]);
    // BlazeComponent will return the first component having rendered an ancestor;
    // so sometimes the inner view is a simple template and not a component; if we do
    // not take care, destroying this view will destroy e.g. parent inner...
    if (candidateInnerComponent !== BlazeComponent.getComponentForElement(this.openerView.firstNode())) {
      this.innerComponent = candidateInnerComponent;
    }
  }

  refresh() {
    PopupComponent.refresh([this]);
  }

  onRendered() {
    if (this.detached) {return}
    // Use plain Blaze stuff to be able to render all templates, but use components when available/relevant
    this.currentView = Blaze.currentView || Blaze.getView(this.component().firstNode());

    // Placement will be related to the opener (usually clicked element)
    // But template data and view related to the opener are not the same:
    // - view is probably outer, as is was already rendered on click
    // - template data could be found with Template.parentData(n), but `n` can
    //   vary depending on context: using those methods feels more reliable for this use case
    this.popupArgs.openerElement ??= this.getOpenerElement(this.currentView);
    this.openerView = Blaze.getView(this.popupArgs.openerElement);
    // With programmatic/click opening, we get the "real" opener; with dynamic
    // templating we get the placeholder and need to go up to get a glimpse of
    // the "real" opener size. It is quite imprecise in that case (maybe the
    // interesting opener is a sibling, not an ancestor), but seems to do the job
    // for now.
    // Also it feels sane that inner content does not have a reference to
    // a virtual placeholder.
    const opener = this.popupArgs.openerElement;
    let sizedOpener = opener;
    if (opener.classList?.contains?.(this.popupPlaceholderClass())) {
      sizedOpener = opener.parentNode;
    }
    // in some cases, opener is re-rendered while popup tries to position
    // better freeze the opener dims
    this.popupArgs.nonPlaceholderDims = sizedOpener.getBoundingClientRect();

    PopupComponent.stack.push(this);

    try {
      this.render();
      // Render above other popups by default
    } catch(e) {
      // If something went wrong during rendering, do not create
      // "zombie" popups
      console.error(`cannot render popup ${this.name}: ${e}`);
      this.destroy();
    }


  }

  // userClose is a boolean attached to the component which tells
  // if the destruction comes from the user, could be useful in callbacks
  destroy(renderParent, userClose) {
    if (this.detached) {return}
    this.userClose = userClose;
    this.detached = true;
    for (const child of this.children) {child.destroy()}
    this.observeChild?.disconnect();

    // not necesserly removed in order, e.g. multiple cards
    PopupComponent.stack = PopupComponent.stack.filter(e => e !== this);
    if (renderParent) {
      PopupComponent.stack.at(-1).refresh();
    }

    // unecessary upon "normal" conditions, but prefer destroy everything
    // in case of partial initialization
    for (const v of [this.currentView, this.outerView, this.innerView]) {
      try {
        Blaze.remove(v);
      } catch {}
    }
    this.innerComponent?.removeComponent?.();
    this.outerComponent?.removeComponent?.();
    this.popupArgs?.afterDestroyed?.(this);
    this.removeComponent();
  }

  closeWithPlaceholder(parentElement) {
    // adapted from https://stackoverflow.com/questions/52834774/dom-event-when-element-is-removed
    // strangely, when opener is removed because of a reactive change, this component
    // do not get any lifecycle hook called, so we need to bridge the gap. Simply
    // "close" popup when placeholder is off-DOM.
    while (parentElement.nodeType === Node.TEXT_NODE) {
      parentElement = parentElement.parentElement;
    }
    const placeholder = parentElement.getElementsByClassName(this.popupPlaceholderClass());
    if (!placeholder.length) {
      return;
    }
    const observer = new MutationObserver(() => {
      // DOM element being suppressed is reflected in array
      if (placeholder.length === 0 && !this.detached) {
        this.destroy();
      }
    });
    observer.observe(parentElement, {childList: true});
  }
}

PopupComponent.register("popup");
PopupDetachedComponent.register('popupDetached');

export default PopupComponent;
// #FIXME for debugging purpose
window.PopupComponent = PopupComponent;