import { List as IList, Map, Range, Set, fromJS } from 'immutable'
import _ from 'lodash'
import PropTypes from 'prop-types'
import React from 'react'
import { Button, Confirm, List, Item } from 'semantic-ui-react'

import { TrackInfoPopup } from './components'
import { effect, combine } from './effects'
import * as lms from './lmsclient'
import { SEARCH_RESULTS } from './search'
import makeReducer from './store'
import { TouchList } from './touch'
import { formatTime, operationError } from './util'
import './playlist.styl'

const IX = "playlist index"
export const SINGLE = "single"
export const TO_LAST = "to last"

export const defaultState = Map({
  playerid: null,
  items: IList(),
  timestamp: null,
  numTracks: 0,
  currentIndex: null,
  currentTrack: Map(),
  selection: Set(),
})

export const reducer = makeReducer({
  "ref:gotPlayer": (state, action, status, {ignoreChange=false}={}) => {
    const effects = []
    const list = status.playlist_loop
    const data = {
      playerid: status.playerid,
      numTracks: status.playlist_tracks,
      timestamp: status.playlist_timestamp || null,
    }
    if (list) {
      const index = parseInt(status.playlist_cur_index)
      const changed = !ignoreChange && isPlaylistChanged(state.toObject(), data)
      const gotCurrent = index >= list[0][IX] && index <= list[list.length - 1][IX]
      data.currentIndex = index
      if (status.isPlaylistUpdate || changed) {
        // TODO merge will return wrong result if all items in playlist have
        // changed but only a subset is loaded in this update
        data.items = mergePlaylist(state.get("items"), list)
        if (gotCurrent) {
          data.currentTrack = fromJS(list[index - list[0][IX]])
        }
      } else {
        data.currentTrack = fromJS(list[0] || {})
      }
      if (changed && (!status.isPlaylistUpdate || !gotCurrent)) {
        effects.push(effect(require("./player").loadPlayer, data.playerid, true))
      }
    } else {
      data.items = IList()
      data.currentIndex = null
      data.currentTrack = Map()
    }
    if (!list || state.get("playerid") !== data.playerid) {
      data.selection = Set()
    }
    return combine(state.merge(data), effects)
  },
  "ref:advanceToNextTrack": (state, action, playerid) => {
    const items = state.get("items")
    const index = state.get("currentIndex")
    const nextIndex = index === null ? null : (index + 1)
    const nextTrack = nextIndex === null ? null :
      items.find(item => item.get(IX) === nextIndex)
    const effects = []
    if (nextIndex !== null && nextTrack) {
      state = state.merge({
        currentTrack: nextTrack,
        currentIndex: nextIndex,
      })
    } else {
      effects.push(effect(
        require("./player").loadPlayer,
        playerid,
        true,
      ))
    }
    return combine(state, effects)
  },
  playlistItemMoved: (state, action, fromIndex, toIndex) => {
    const selection = state.get("selection")
    let currentIndex = state.get("currentIndex")
    let between, stop, step
    if (fromIndex < toIndex) {
      between = i => i > fromIndex && i < toIndex
      stop = toIndex
      step = 1
    } else { // fromIndex > toIndex
      between = i => i >= toIndex && i < fromIndex
      stop = toIndex - 1
      step = -1
    }
    if (fromIndex === currentIndex) {
      currentIndex = toIndex + (fromIndex < toIndex ? -1 : 0)
    } else if (between(currentIndex)) {
      currentIndex -= step
    }
    const reindex = i => between(i) ? i - step : i
    const deselect = Range(fromIndex, stop, step)
      .takeWhile(i => i === fromIndex || selection.has(i))
      .toSet()
    return state.merge({
      items: moveItem(state.get("items"), fromIndex, toIndex),
      selection: selection.subtract(deselect).map(reindex).toSet(),
      currentIndex: currentIndex,
      currentTrack: state.get("currentTrack").set(IX, currentIndex),
    })
  },
  playlistItemDeleted: (state, action, index) => {
    const oldItems = state.get("items")
    const items = deleteItem(oldItems, index)
    if (items.equals(oldItems)) {
      return state
    }
    const reindex = x => x > index ? x -= 1 : x
    const data = {
      items,
      numTracks: state.get("numTracks") - 1,
      selection: state.get("selection").remove(index).map(reindex),
    }
    const currentIndex = state.get("currentIndex")
    if (index <= currentIndex) {
      data.currentIndex = currentIndex - 1
      data.currentTrack = state.get("currentTrack").set(IX, currentIndex - 1)
    }
    return state.merge(data)
  },
  selectionChanged: (state, action, selection) => {
    return state.set("selection", selection)
  },
  clearSelection: state => state.set("selection", Set()),
}, defaultState)

const actions = reducer.actions

function insertPlaylistItems(playerid, items, index, dispatch, numTracks) {
  const insert = (items, index, numTracks) => {
    if (!items.length) {
      return
    }
    const item = items.shift()
    const param = lms.getControlParam(item)
    if (param) {
      lms.command(playerid, "playlistcontrol", "cmd:add", param)
        // TODO do not hard-code playlist range
        .then(() => lms.getPlayerStatus(playerid, 0, 100))
        .then(data => {
          // HACK will new items be in the playlist when moveItems is called?
          dispatch(actions.gotPlayer(data))
          if (index < numTracks) {
            const selection = Range(numTracks, data.playlist_tracks)
            return moveItems(selection, index, playerid, dispatch, lms)
          }
        })
        .then(() => lms.getPlayerStatus(playerid))
        .then(data => {
          dispatch(actions.gotPlayer(data, {ignoreChange: true}))
          const length = data.playlist_tracks
          const inserted = length - numTracks
          if (inserted >= 0) {
            insert(items, index + inserted, length)
          }
        })
        .catch(err => {
          dispatch(operationError("Move error", err))
        })
    } else {
      window.console.log("unknown item", item)
      insert(items, index, numTracks)
    }
  }
  insert(items, index, numTracks)
}

export function moveItems(selection, toIndex, playerid, dispatch, lms) {
  return new Promise(resolve => {
    function move(items) {
      if (!items.length) {
        return resolve(true)
      }
      const [from, to] = items.shift()
      lms.command(playerid, "playlist", "move", from, to > from ? to - 1 : to)
        .then(() => {
          // TODO abort if playerid or selection changed
          dispatch(actions.playlistItemMoved(from, to))
          move(items)
        })
        .catch(err => {
          dispatch(operationError("Move error", err))
          resolve(true)
        })
    }
    function getMoves(selected) {
      selected.cacheResult()
      const len = selected.size
      let min = _.min([toIndex, selected.min()])
      let max = _.max([toIndex - 1, selected.max()]) + 1
      const invert = max - min - len < len
      if (invert) {
        return Range(min, max)
          .filter(i => !selection.has(i))
          .map(i => i < toIndex ? [i, min++] : [i, max])
      }
      min = max = toIndex
      return selected.map(i => i < toIndex ? [i, min--] : [i, max++])
    }
    const isValidMove = (from, to) => from !== to && from + 1 !== to
    let items
    if (selection.size) {
      const selected = selection.toSeq().sort()
      const botMoves = getMoves(selected.filter(i => i < toIndex).reverse())
      const topMoves = getMoves(selected.filter(i => i >= toIndex))
      items = botMoves.concat(topMoves)
        .filter(([f, t]) => isValidMove(f, t))
        .toArray()
      if (!items.length) {
        return resolve(false)
      }
    } else {
      return resolve(false)
    }
    move(items)
  })
}

export function deleteSelection(playerid, selection, dispatch, lms) {
  return new Promise(resolve => {
    function remove(items) {
      if (!items.length) {
        return resolve()
      }
      const index = items.shift()
      lms.command(playerid, "playlist", "delete", index)
        .then(() => {
          // TODO abort if playerid or selection changed
          dispatch(actions.playlistItemDeleted(index))
          remove(items)
        })
        .catch(err => {
          dispatch(operationError("Delete error", err))
          resolve()
        })
    }
    const items = selection
      .toSeq()
      .sortBy(index => -index)
      .toArray()
    remove(items)
  })
}

function isPlaylistChanged(prev, next) {
  const playlistSig = obj => Map({
    playerid: obj.playerid,
    timestamp: obj.timestamp,
    numTracks: obj.numTracks,
  })
  return !playlistSig(prev).equals(playlistSig(next))
}

/**
 * Merge array of playlist items into existing playlist
 *
 * @param list - List of Maps.
 * @param array - Array of objects.
 * @returns Merged List of Maps.
 */
function mergePlaylist(list, array) {
  function next() {
    if (i < len) {
      const obj = array[i]
      i += 1
      return Map(obj)
    }
    return null
  }
  const len = array.length
  if (!len) {
    return list
  }
  const merged = []
  let i = 0
  let newItem = next()
  list.forEach(item => {
    const index = item.get(IX)
    while (newItem && newItem.get(IX) < index) {
      merged.push(newItem)
      newItem = next()
    }
    if (newItem && newItem.get(IX) !== index) {
      merged.push(item)
    }
  })
  while (newItem) {
    merged.push(newItem)
    newItem = next()
  }
  return IList(merged)
}

/**
 * Delete item from playlist and re-index other items
 *
 * @param list - List of Maps.
 * @param index - Index of item to delete.
 * @returns List of Maps.
 */
export function deleteItem(list, index) {
  return list.toSeq()
    .filter(item => item.get(IX) !== index)
    .map(item => {
      const ix = item.get(IX)
      if (ix > index) {
        item = item.set(IX, ix - 1)
      }
      return item
    })
    .toList()
}

/**
 * Move item in playlist and re-index other items
 *
 * @param list - List of Maps.
 * @param fromIndex - Index of item being moved.
 * @param toIndex - Index to which item is to be moved.
 * @returns List of Maps.
 */
export function moveItem(list, fromIndex, toIndex) {
  const to = toIndex > fromIndex ? toIndex - 1 : toIndex
  return list.toSeq()
    .filter(item => item.get(IX) !== fromIndex)
    .splice(to, 0, list.get(fromIndex))
    .map((item, i) => item.set(IX, i))
    .toList()
}

export class Playlist extends React.Component {
  constructor(props, context) {
    super(props)
    this.state = {infoIndex: -1, promptForDelete: ""}
    const onDelete = this.onDeleteItems.bind(this)
    context.addKeydownHandler(8 /* backspace */, onDelete)
    context.addKeydownHandler(46 /* delete */, onDelete)
    this.selectionChangedListener = null
    this.hideTrackInfo = () => {}
  }
  toPlaylistIndex(touchlistIndex) {
    return this.props.items.getIn([touchlistIndex, IX])
  }
  playTrackAtIndex(playlistIndex) {
    const loadPlayer = require("./player").loadPlayer
    const { playerid, dispatch } = this.props
    lms.command(playerid, "playlist", "index", playlistIndex)
      .then(() => dispatch(actions.clearSelection()))
      // HACK load again after 1 second because LMS sometimes returns
      // the wrong "time" on loadPlayer immediately after a command.
      .then(() => loadPlayer(playerid, true, {statusInterval: 1}))
      .catch(err => operationError("Cannot play", err))
      .then(dispatch)
    this.hideTrackInfo()
  }
  onLongTouch(item, index) {
    // show info icon after selection changes
    setTimeout(() => this.setInfoIndex(index), 0)
    // hide info icon after short delay
    setTimeout(() => this.setInfoIndex(-1), 3000)
    return true
  }
  setInfoIndex(index) {
    if (this.state.infoIndex !== index) {
      this.setState({infoIndex: index})
    }
  }
  onMoveItems(selection, toIndex) {
    const loadPlayer = require("./player").loadPlayer
    const { playerid, dispatch } = this.props
    selection = selection.map(i => this.toPlaylistIndex(i))
    toIndex = this.toPlaylistIndex(toIndex)
    moveItems(selection, toIndex, playerid, dispatch, lms)
      .then(() => loadPlayer(playerid, true))
      .catch(err => operationError("Move error", err))
      .then(dispatch)
  }
  onDeleteItems() {
    const number = this.props.selection.size
    let prompt
    if (number) {
      prompt = "Delete " + number + " song" + (number > 1 ? "s" : "")
    } else {
      prompt = "Clear playlist"
    }
    this.setState({promptForDelete: prompt})
  }
  deleteItems() {
    const loadPlayer = require("./player").loadPlayer
    const selection = this.props.selection.map(i => this.toPlaylistIndex(i))
    const { playerid, dispatch } = this.props
    this.setState({promptForDelete: ""})
    if (selection.size) {
      deleteSelection(playerid, selection, dispatch, lms)
        .then(() => loadPlayer(playerid, true))
        .catch(err => operationError("Delete error", err))
        .then(dispatch)
    } else {
      lms.command(playerid, "playlist", "clear")
        .then(() => loadPlayer(playerid, true))
        .catch(err => operationError("Cannot clear playlist", err))
        .then(dispatch)
    }
  }
  onDrop(data, dataType, index) {
    if (dataType === SEARCH_RESULTS) {
      const {playerid, dispatch, numTracks} = this.props
      index = this.toPlaylistIndex(index)
      insertPlaylistItems(playerid, data, index, dispatch, numTracks)
    }
  }
  onSelectionChanged(selection) {
    this.props.dispatch(actions.selectionChanged(selection))
    this.setInfoIndex(-1)
    this.hideTrackInfo()
  }
  setHideTrackInfoCallback(callback) {
    this.hideTrackInfo = callback
  }
  render() {
    const props = this.props
    const hideInfo = this.setHideTrackInfoCallback.bind(this)
    return <div>
      <TouchList
          className="playlist"
          items={props.items}
          selection={props.selection}
          dropTypes={[SEARCH_RESULTS]}
          onDrop={this.onDrop.bind(this)}
          onLongTouch={this.onLongTouch.bind(this)}
          onMoveItems={this.onMoveItems.bind(this)}
          onSelectionChanged={this.onSelectionChanged.bind(this)}>
        {props.items.toSeq().map((item, index) => {
          item = item.toObject()
          return <PlaylistItem
            item={item}
            playTrack={this.playTrackAtIndex.bind(this, item[IX])}
            index={index}
            activeIcon={props.currentIndex === item[IX] ? "video play" : ""}
            selecting={props.selection.size}
            setHideTrackInfoCallback={hideInfo}
            showInfoIcon={index === this.state.infoIndex}
            key={index + "-" + item.id} />
        }).toArray()}
      </TouchList>
      <Button.Group basic size="small">
        <Button
          icon="remove"
          content={props.selection.size ? "Delete" : "Clear Playlist"}
          labelPosition="left"
          onClick={() => this.onDeleteItems()} />
      </Button.Group>
      <Confirm
        open={Boolean(this.state.promptForDelete)}
        content={this.state.promptForDelete + "?"}
        confirmButton={(this.state.promptForDelete || "").replace(/ .*$/, "")}
        onCancel={() => this.setState({promptForDelete: ""})}
        onConfirm={this.deleteItems.bind(this)} />
    </div>
  }
}

Playlist.contextTypes = {
  addKeydownHandler: PropTypes.func.isRequired,
}

export const PlaylistItem = props => {
  const item = props.item
  return <TouchList.Item
      index={props.index}
      onDoubleClick={props.playTrack}
      draggable>
    <List.Content floated="right">
      <List.Description className={props.selecting ? "drag-handle" : ""}>
        {formatTime(item.duration || 0)}
        {props.selecting ? <DragHandle /> : ""}
      </List.Description>
    </List.Content>
    <List.Content>
      <List.Description className="title">
        <TrackInfoPopup {...props}>
          <Button icon="play" floated="right" onClick={props.playTrack}
            style={{"margin": "0 0 1em 1em"}} />
          <Item.Header>{item.title}</Item.Header>
          {_.map([item.artist, item.composer, item.album], text => (
            text ? <Item.Meta key={text}>{text}</Item.Meta> : ""
          ))}
          <Item.Meta>
            {_.filter([item.genre, item.year]).join(" | ")}
          </Item.Meta>
          {""/*<Item.Description>...</Item.Description>*/}
        </TrackInfoPopup>
        {songTitle(item)}
      </List.Description>
    </List.Content>
  </TouchList.Item>
}

function songTitle({artist, title}) {
  if (artist && title) {
    return artist + " - " + title
  }
  return artist || title || "..."
}

const DragHandle = () => (
  <span className="gap-left">
    <i className="fa fa-reorder"></i>
  </span>
)
