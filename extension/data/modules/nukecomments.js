'use strict';

/** @module CommentNuke **/
function nukecomments () {
    const self = new TB.Module('Comment Nuke');
    self.shortname = 'CommentNuke';

    // Default settings
    self.settings['enabled']['default'] = false;
    self.config['betamode'] = false;

    self.register_setting('ignoreDistinguished', {
        type: 'boolean',
        default: true,
        title: 'Ignore distinguished comments from mods and admins when nuking a chain.',
    });

    // Settings for old reddit only
    self.register_setting('showNextToUser', {
        type: 'boolean',
        default: true,
        advanced: true,
        title: 'Show nuke button next to the username instead of under the comment.',
        oldReddit: true,
    });

    self.init = function () {
        // This will contain a flat listing of all comments to be removed.
        let removalChain = [];
        // Distinguished chain
        let distinguishedComments = [];
        // If we do get api errors we put the comment id in here so we can retry removing them.
        let missedComments = [];
        let removalRunning = false;
        let nukeOpen = false;
        const $body = $('body');

        const ignoreDistinguished = self.setting('ignoreDistinguished'),
              showNextToUser = self.setting('showNextToUser');

        // Nuke button clicked
        $body.on('click', '.tb-nuke-button', function (event) {
            self.log('nuke button clicked.');
            if (nukeOpen) {
                TB.ui.textFeedback('Nuke popup is already open.', TBui.FEEDBACK_NEGATIVE);
                return;
            }
            TB.ui.longLoadSpinner(true);

            nukeOpen = true;
            removalChain = [];
            missedComments = [];
            distinguishedComments = [];

            const $this = $(this);
            const commentID = $this.attr('data-comment-id');
            const postID = $this.attr('data-post-id');
            const subreddit = $this.attr('data-subreddit');
            const positions = TBui.drawPosition(event);

            const fetchURL = `/r/${subreddit}/comments/${postID}/slug/${commentID}.json?limit=1500`;

            const $popupContents = $(`<div class="tb-nuke-popup-content">
                <div class="tb-nuke-feedback">Fetching all comments belonging to chain.</div>
                <div class="tb-nuke-details"></div>
            </div>`);

            // Pop-up
            const $popup = TB.ui.popup({
                title: 'Nuke comment chain',
                tabs: [
                    {
                        title: 'Nuke tab',
                        tooltip: '',
                        content: $popupContents,
                        footer: '<button class="tb-execute-nuke tb-action-button">Execute</button> <button class="tb-retry-nuke tb-action-button">Retry</button>',
                    },
                ],
                cssClass: 'nuke-button-popup',
                draggable: true,
            }).appendTo($body)
                .css({
                    left: positions.leftPosition,
                    top: positions.topPosition,
                    display: 'block',
                });

            TBUtils.getJSON(fetchURL, {raw_json: 1}).then(data => {
                TBStorage.purifyObject(data);
                parseComments(data[1].data.children[0], postID, subreddit).then(() => {
                    TB.ui.longLoadSpinner(false);
                    $popup.find('.tb-nuke-feedback').text('Finished analyzing comments.');

                    const removalChainLength = removalChain.length;
                    // Distinguished chain
                    const distinguishedCommentsLength = distinguishedComments.length;

                    $popup.find('.tb-nuke-details').html(TBStorage.purify(`
                    <p>${removalChainLength + distinguishedCommentsLength} comments found (Already removed comments not included).</p>
                    <p>${distinguishedCommentsLength} distinguished comments found.</p>
                    <p><label><input type="checkbox" class="tb-ignore-distinguished-checkbox" ${ignoreDistinguished ? ' checked="checked"' : ''}>Ignore distinguished comments from mods and admins</label></p>
                    `));
                    $popup.find('.tb-execute-nuke').show();
                });
            });

            $popup.on('click', '.tb-execute-nuke, .tb-retry-nuke', function () {
                removalRunning = true;
                TB.ui.longLoadSpinner(true);
                const $this = $(this);
                $this.hide();
                let removalArray;
                const $nukeFeedback = $popup.find('.tb-nuke-feedback');
                const $nukeDetails = $popup.find('.tb-nuke-details');
                const temptIgnoreDistinguished = $popup.find('.tb-ignore-distinguished-checkbox').prop('checked');
                if ($this.hasClass('tb-retry-nuke')) {
                    removalArray = missedComments;
                    missedComments = [];
                } else {
                    if (temptIgnoreDistinguished) {
                        removalArray = removalChain;
                    } else {
                        removalArray = removalChain.concat(distinguishedComments);
                    }
                }

                $nukeFeedback.text('Removing comments.');
                $nukeDetails.html('');

                // Oldest comments first.
                removalArray = TBUtils.saneSort(removalArray);
                const removalArrayLength = removalArray.length;
                let removalCount = 0;
                TBUtils.forEachChunkedRateLimit(removalArray, 20, comment => {
                    removalCount++;
                    TB.ui.textFeedback(`Removing comment ${removalCount}/${removalArrayLength}`, TB.ui.FEEDBACK_NEUTRAL);
                    TBUtils.removeThing(`t1_${comment}`, false, result => {
                        if (!result) {
                            missedComments.push(comment);
                        }
                    });
                }, () => {
                    removalRunning = false;
                    TB.ui.longLoadSpinner(false);
                    $nukeFeedback.text('Done removing comments.');
                    const missedLength = missedComments.length;
                    if (missedLength) {
                        $nukeDetails.text(`${missedLength}: not removed because of API errors. Hit retry to attempt removing them again.`);
                        $popup.find('.tb-retry-nuke').show;
                    } else {
                        setTimeout(() => {
                            $popup.find('.close').click();
                        }, 1500);
                    }
                });
            });

            $popup.on('click', '.close', () => {
                if (removalRunning) {
                    TB.ui.textFeedback('Comment chain nuke in progress, cannot close popup.', TBui.FEEDBACK_NEGATIVE);
                } else {
                    $popup.remove();
                    nukeOpen = false;
                }
            });
        });

        /**
         * Will given a reddit API comment object go through the chain and put all comments
         * @function parseComments
         * @param {object} object Comment chain object
         * @param {string} postID Post id the comments belong to
         * @param {string} subreddit Subreddit the comment chain belongs to.
         * @returns {Promise}
         */

        async function parseComments (object, postID, subreddit) {
            switch (object.kind) {
            case 'Listing': {
                for (let i = 0; i < object.data.children.length; i++) {
                    await parseComments(object.data.children[i], postID, subreddit);
                }
                break;
            }

            case 't1': {
                const distinguishedType = object.data.distinguished;
                if ((distinguishedType === 'admin' || distinguishedType === 'moderator') && !distinguishedComments.includes(object.data.id)) {
                    distinguishedComments.push(object.data.id);
                    // Ignore already removed stuff to lower the amount of calls we need to make.
                } else if (!removalChain.includes(object.data.id) && !object.data.removed && !object.data.spam) {
                    removalChain.push(object.data.id);
                }

                if (object.data.hasOwnProperty('replies') && object.data.replies && typeof object.data.replies === 'object') {
                    await parseComments(object.data.replies, postID, subreddit); // we need to go deeper.
                }
                break;
            }

            case 'more': {
                self.log('"load more" encountered, going even deeper');
                let commentIDs = object.data.children;
                if (!commentIDs.length) {
                    // "continue this thread" links generated when a thread gets
                    // too deep return empty `children` lists, thanks Reddit
                    commentIDs = [object.data.parent_id.substring(3)];
                }

                for (const id of commentIDs) {
                    const fetchUrl = `/r/${subreddit}/comments/${postID}/slug/${id}.json?limit=1500`;
                    // Lets get the comments.
                    const data = await TBUtils.getJSON(fetchUrl, {raw_json: 1});
                    TBStorage.purifyObject(data);
                    await parseComments(data[1].data.children[0], postID, subreddit);
                }
            }
                break;
            default: {
                self.log('default, this should not happen...');
                // This shouldn't actually happen...
            }
            }
        }

        // Add nuke buttons where needed
        TB.listener.on('comment', e => {
            const pageType = TBUtils.pageDetails.pageType;
            const $target = $(e.target);
            const subreddit = e.detail.data.subreddit.name;
            const commentID = e.detail.data.id.substring(3);
            const postID = e.detail.data.post.id.substring(3);

            TBUtils.getModSubs(() => {
                // We have to mod the subreddit to show the button
                if (!TBUtils.modsSub(subreddit)) {
                    return;
                }
                // We also have to be on a comments page or looking at a context popup
                if (pageType !== 'subredditCommentsPage' && pageType !== 'subredditCommentPermalink' && !$target.closest('.context-button-popup').length) {
                    return;
                }

                const NukeButtonHTML = `<span class="tb-nuke-button tb-bracket-button" data-comment-id="${commentID}" data-post-id="${postID}" data-subreddit="${subreddit}" title="Remove comment chain starting with this comment">${e.detail.type === 'TBcommentOldReddit' && !showNextToUser ? 'Nuke' : 'R'}</span>`;
                if (showNextToUser && TBUtils.isOldReddit) {
                    const $userContainter = $target.closest('.entry, .tb-comment-entry').find('.tb-jsapi-author-container .tb-frontend-container');
                    $userContainter.append(NukeButtonHTML);
                } else {
                    $target.append(NukeButtonHTML);
                }
            });
        });
    };

    TB.register_module(self);
} // nukecomments() wrapper

window.addEventListener('TBModuleLoaded', () => {
    nukecomments();
});
