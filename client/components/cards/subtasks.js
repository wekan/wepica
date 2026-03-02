import { ReactiveCache } from '/imports/reactiveCache';
import { FlowRouter } from 'meteor/ostrio:flow-router-extra';

const { calculateIndexData } = Utils;

// #FIXME a lot of duplication with checklists, maybe could be factorized
BlazeComponent.extendComponent({
  subtaskCard($parentDOM) {
    if (!$parentDOM) { return }
    const subtaskNode = $parentDOM.find('.subtask').get(0);
    if (!subtaskNode) { return }
    return Blaze.getData(subtaskNode)?.subtask;
  },
  initSorting() {
    // #FIXME I poorly coded trying to make existing code work
    const items = this.$(this.itemSelector).parent();
    const self = this;
    items.mousedown(function (evt) {
      evt.stopPropagation();
    });
    items.sortable({
      tolerance: 'pointer',
      helper: 'clone',
      items: '.js-subtasks-item:not(.placeholder)',
      connectWith: '.js-subtasks',
      appendTo: 'parent',
      distance: 7,
      placeholder: 'subtask placeholder',
      handle: self.handleSelector,
      scroll: true,
      start(evt, ui) {
        ui.placeholder.height(ui.helper.height());
        EscapeActions.clickExecute(evt.target, 'inlinedForm');
      },
      stop(evt, ui) {
        const prevSubtask = self.subtaskCard(ui.item.prev('.js-subtasks-item'));
        let nextSubtask = self.subtaskCard(ui.item.next('.js-subtasks-item'));
        const nItems = 1;
        const sortIndex = calculateIndexData(prevSubtask, nextSubtask, nItems);
        const subtask = self.subtaskCard(ui.item);
        if (subtask) {
          subtask.move(subtask.boardId, subtask.swimlaneId, subtask.listId, sortIndex.base);
        }
        items.sortable('cancel');
      },
    });
  },
  onRendered() {
    this.handleSelector = Utils.isMiniScreen() ? 'span.fa.subtaskitem-handle' : '.item-title';
    this.itemSelector = '.js-subtasks-item';
    this.initSorting();
    // Disable sorting if the current user is not a board member
    this.autorun(() => {
      const disabled = !ReactiveCache.getCurrentUser()?.isBoardMember();
      const items = this.$(this.itemSelector);
      if (items.data('uiSortable') || items.data('sortable')) {
        items.sortable('option', 'disabled', disabled);
      }
    });
  },
  addSubtask(event) {
    event.preventDefault();
    const textarea = this.find('.js-add-subtask textarea');
    const title = textarea.value.trim();
    const cardId = this.currentData().cardId;
    const card = ReactiveCache.getCard(cardId);
    const subtasks = this.$(this.itemSelector) || [];
    let sortIndex = 0;
    if (subtasks.length > 0) {
      const subtask = this.subtaskCard(subtasks.last());
      sortIndex = Utils.calculateIndexData(subtask, null).base;
    }
    const crtBoard = ReactiveCache.getBoard(card.boardId);
    const targetBoard = crtBoard.getDefaultSubtasksBoard();
    const listId = targetBoard.getDefaultSubtasksListId();

    //Get the full swimlane data for the parent task.
    const parentSwimlane = ReactiveCache.getSwimlane({
      boardId: crtBoard._id,
      _id: card.swimlaneId,
    });
    // if no list specified, find the swimlane of the same name in the target board.
    let targetSwimlane = ReactiveCache.getSwimlane({_id: ReactiveCache.getList(listId)?.swimlaneId});
    targetSwimlane ??= ReactiveCache.getSwimlane({
      boardId: targetBoard._id,
      title: parentSwimlane.title,
    });
    //If no swimlane with a matching title exists in the target board, create one
    targetSwimlane ??= targetBoard.getDefaultSwimline();

    const nextCardNumber = targetBoard.getNextCardNumber();

    if (title) {
      const _id = Cards.insert({
        title,
        parentId: cardId,
        members: [],
        labelIds: [],
        customFields: [],
        listId,
        boardId: targetBoard._id,
        sort: sortIndex,
        swimlaneId: targetSwimlane._id,
        type: 'cardType-card',
        cardNumber: nextCardNumber
      });

      // In case the filter is active we need to add the newly inserted card in
      // the list of exceptions -- cards that are not filtered. Otherwise the
      // card will disappear instantly.
      // See https://github.com/wekan/wekan/issues/80
      Filter.addException(_id);

      setTimeout(() => {
        this.$('.add-subtask-item')
          .last()
          .click();
      }, 100);
    }
    textarea.value = '';
    textarea.focus();

    this.initSorting();
  },

  async deleteSubtask() {
    const subtask = this.currentData().subtask;
    if (subtask && subtask._id) {
      await subtask.archive();
    }
  },

  currentCard() {
    // prefer relying on the actual current card rather than on the "current" card
    // before the two was the same because only one popup/card detail could be opened
    return ReactiveCache.getCard(this.data().cardId);
  },

  events() {
    return [
      {
        'submit .js-add-subtask': this.addSubtask,
      },
    ];
  },
}).register('subtasks');

BlazeComponent.extendComponent({
  async toggleItem() {
    const item = this.currentData().subtask;
    if (item && item._id) {
      await item.toggleSubtaskFinishedStatus();
    }
  },

  async editSubtask(event) {
    event.preventDefault();
    const textarea = this.find('textarea.js-edit-subtask-item');
    const title = textarea.value.trim();
    const subtask = this.currentData().subtask;
    await subtask.setTitle(title);
  },
  events() {
    // previously these events were catched in the parent component,
    // which manages the list. however, this was a problem because
    // the clicked component was within the parent, thus not having
    // access to the subtask particular data. This should be
    // more understandable in the subtask's component.
    return [
      {
        'click .js-open-subtask-details-menu'(e) {
          Popup.open('subtaskActions')(e, { forceData: this});
        },
        'click .js-delete-subtask': this.deleteSubtask,
        'submit .js-edit-subtask-title': this.editSubtask,
        'click .js-subtask-title .check-box': this.toggleItem,
      }
    ]
  }
}).register('subtaskDetail');

BlazeComponent.extendComponent({
  events() {
    return [
      {
        'click .js-view-subtask'(event) {
          // data() = component of clicked subtask
          if ($(event.target).hasClass('js-view-subtask')) {
            const subtask = this.data().subtask;
            const board = subtask.board();
            //
            FlowRouter.go('card', {
              boardId: board._id,
              slug: board.slug,
              cardId: subtask._id,
            });
          }
        },
        'click .js-delete-subtask' : Popup.afterConfirm('subtaskDelete', async function () {
          Popup.back(2);
          if (this.subtask && this.subtask._id) {
            await this.subtask.archive();
          }
        }),
      }
    ]
  }
}).register('subtaskActionsPopup');

BlazeComponent.extendComponent({
  user() {
    return ReactiveCache.getUser(this.userId);
  },
  isBoardAdmin() {
    return ReactiveCache.getCurrentUser().isBoardAdmin();
  },
}).register('editSubtaskItemForm');
