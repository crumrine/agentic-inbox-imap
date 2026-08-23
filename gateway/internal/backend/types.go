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

// BodyStructureVersion is the storage format the gateway understands. A
// payload carrying any other version is ignored in favour of deriving the
// structure from the raw message, rather than risking a partial decode of
// a shape this build does not know.
//
// It mirrors BODY_STRUCTURE_VERSION in workers/imap/bodystructure.ts.
const BodyStructureVersion = 1

// BodyStructureDisposition is a Content-Disposition, mirroring
// StoredDisposition on the Worker side.
type BodyStructureDisposition struct {
	Value  string            `json:"value"`
	Params map[string]string `json:"params,omitempty"`
}

// BodyStructureNode is one node of a precomputed BODYSTRUCTURE, mirroring
// StoredSinglePart and StoredMultiPart in workers/imap/bodystructure.ts.
//
// The two are one Go struct because the wire format distinguishes them by
// the presence of children rather than by a discriminant field: a single
// part's type is an arbitrary token, so "multipart" is not something to
// switch on.
//
// Version is set only on the root, which is where the envelope wraps it.
// Absent optional fields decode to the Go zero value, which is exactly what
// the Worker's format assumes.
type BodyStructureNode struct {
	// Version is the envelope's "v", present on the root node only.
	Version int `json:"v,omitempty"`

	Type    string            `json:"type"`
	Subtype string            `json:"subtype"`
	Params  map[string]string `json:"params,omitempty"`

	// Single-part fields.
	ID          string `json:"id,omitempty"`
	Description string `json:"description,omitempty"`
	Encoding    string `json:"encoding,omitempty"`
	Size        uint32 `json:"size,omitempty"`
	// NumLines is present only for text/*.
	NumLines int64 `json:"numLines,omitempty"`

	// Extended fields, carried on both kinds of node.
	Disposition *BodyStructureDisposition `json:"disposition,omitempty"`
	Language    []string                  `json:"language,omitempty"`
	Location    string                    `json:"location,omitempty"`

	// Children is non-empty for a multipart and absent otherwise.
	Children []BodyStructureNode `json:"children,omitempty"`
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

	// BodyStructure is the Worker's precomputed BODYSTRUCTURE, or nil.
	//
	// It is additive and exact-or-absent: the deriver returns nothing
	// rather than approximating, and nothing was backfilled, so most
	// messages have none. Nil is the ordinary case, not an error, and the
	// gateway falls back to deriving the structure from the raw message.
	BodyStructure *BodyStructureNode `json:"bodyStructure,omitempty"`
}

// MessagesPage is the response body of
// GET /api/imap/v1/{mailbox}/{folder}/messages.
type MessagesPage struct {
	Messages []Message `json:"messages"`
	UIDNext  uint32    `json:"uidNext"`
}

// FlagUpdate is one message's flag change in a POST
// /api/imap/v1/{mailbox}/{folder}/flags request.
//
// Add and Remove are applied in that order by the Worker, so naming the
// same flag in both is a set, not a clear.
type FlagUpdate struct {
	UID    uint32   `json:"uid"`
	Add    []string `json:"add"`
	Remove []string `json:"remove"`
}

// FlagResult is one message's complete flag set after the update, which is
// what lets the gateway emit an accurate untagged FETCH without re-reading
// the message.
type FlagResult struct {
	UID   uint32   `json:"uid"`
	Flags []string `json:"flags"`
}

// FlagsPage is the response body of POST
// /api/imap/v1/{mailbox}/{folder}/flags.
//
// UIDs the Worker does not recognise are silently absent from Updated;
// that is how a message deleted underneath the session is reported.
type FlagsPage struct {
	Updated []FlagResult `json:"updated"`
}

// CopiedMessage pairs a source UID with the UID the message received in the
// destination folder. UIDs are per folder, so a copy or move always mints a
// new one.
type CopiedMessage struct {
	SourceUID uint32 `json:"sourceUid"`
	DestUID   uint32 `json:"destUid"`
}

// CopyPage is the response body of POST
// /api/imap/v1/{mailbox}/{folder}/copy.
//
// UIDs the Worker does not recognise are silently absent from Copied.
type CopyPage struct {
	Copied []CopiedMessage `json:"copied"`
}

// MovePage is the response body of POST
// /api/imap/v1/{mailbox}/{folder}/move.
type MovePage struct {
	Moved []CopiedMessage `json:"moved"`
}

// ExpungePage is the response body of POST
// /api/imap/v1/{mailbox}/{folder}/expunge. Expunged holds the source UIDs
// actually removed, ascending.
//
// The server-side rule is that expunging moves a message to Trash from
// every folder except Trash itself, where it is destroyed. Either way the
// message is gone from the folder the client is looking at, which is all
// an IMAP client can observe.
type ExpungePage struct {
	Expunged []uint32 `json:"expunged"`
}

// AppendResult is the response body of POST
// /api/imap/v1/{mailbox}/{folder}/append.
//
// Deduplicated reports that a message with the same Message-ID already
// existed and its UID was returned instead of a new one being written.
// Clients APPEND a Sent copy after submission and the app records its own,
// so without that the folder would show every sent message twice.
type AppendResult struct {
	UID          uint32 `json:"uid"`
	UIDValidity  uint32 `json:"uidValidity"`
	Deduplicated bool   `json:"deduplicated"`
}

// SubmitResult is the response body of POST /api/imap/v1/{mailbox}/submit.
//
// SentUID and SentUIDValidity identify the copy the Worker filed in the
// Sent folder, so a submission and the record of it are one operation
// rather than two that can disagree.
type SubmitResult struct {
	MessageID       string `json:"messageId"`
	SentUID         uint32 `json:"sentUid"`
	SentUIDValidity uint32 `json:"sentUidValidity"`
}
