// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package backend

import "time"

// AuthResult is the response body of a successful POST /api/imap/v1/auth.
type AuthResult struct {
	Mailbox string `json:"mailbox"`
}

// Folder describes one mailbox folder, as returned by
// GET /api/imap/v1/{mailbox}/folders.
type Folder struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	UIDValidity uint32 `json:"uidValidity"`
	UIDNext     uint32 `json:"uidNext"`
	Exists      uint32 `json:"exists"`
	Unseen      uint32 `json:"unseen"`
	Recent      uint32 `json:"recent"`
}

// Address is a single envelope address (From/To/Cc entry).
type Address struct {
	Name    string `json:"name"`
	Address string `json:"address"`
}

// Envelope mirrors the IMAP ENVELOPE fields the Worker returns per message.
type Envelope struct {
	Subject   string    `json:"subject"`
	From      []Address `json:"from"`
	To        []Address `json:"to"`
	Cc        []Address `json:"cc"`
	MessageID string    `json:"messageId"`
	InReplyTo string    `json:"inReplyTo"`
	Date      string    `json:"date"`
}

// Message is one message summary, as returned by
// GET /api/imap/v1/{mailbox}/{folder}/messages.
type Message struct {
	UID          uint32    `json:"uid"`
	Flags        []string  `json:"flags"`
	InternalDate time.Time `json:"internalDate"`
	RFC822Size   int64     `json:"rfc822Size"`
	Envelope     Envelope  `json:"envelope"`
	HasRaw       bool      `json:"hasRaw"`
}

// MessagesPage is the response body of
// GET /api/imap/v1/{mailbox}/{folder}/messages.
type MessagesPage struct {
	Messages []Message `json:"messages"`
	UIDNext  uint32    `json:"uidNext"`
}
