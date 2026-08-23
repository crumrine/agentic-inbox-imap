// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
)

// bsMessage is a multipart/mixed with a text part and a base64 attachment,
// which between them exercise every field the stored format carries:
// params, an id, a description, an encoding, a line count and a
// disposition with its own params.
const bsMessage = "From: sender@example.com\r\n" +
	"To: user@example.com\r\n" +
	"Subject: report attached\r\n" +
	"MIME-Version: 1.0\r\n" +
	"Content-Type: multipart/mixed; boundary=\"B\"\r\n" +
	"\r\n" +
	"--B\r\n" +
	"Content-Type: text/plain; charset=utf-8\r\n" +
	"\r\n" +
	"here is the report\r\n" +
	"--B\r\n" +
	"Content-Type: application/pdf; name=\"report.pdf\"\r\n" +
	"Content-Id: <att-1@example.com>\r\n" +
	"Content-Description: quarterly report\r\n" +
	"Content-Transfer-Encoding: base64\r\n" +
	"Content-Disposition: attachment; filename=\"report.pdf\"\r\n" +
	"\r\n" +
	"cGRmIGJ5dGVz\r\n" +
	"--B--\r\n"

// bsMessageStored is what the Worker stores for bsMessage: hand-written to
// mirror StoredBodyStructure in workers/imap/bodystructure.ts rather than
// generated from the Go side, so that the comparison against
// ExtractBodyStructure is a genuine cross-check of the format and not a
// round trip through this package's own understanding of it.
func bsMessageStored() *backend.BodyStructureNode {
	return &backend.BodyStructureNode{
		Version: backend.BodyStructureVersion,
		Type:    "multipart",
		Subtype: "mixed",
		Params:  map[string]string{"boundary": "B"},
		Children: []backend.BodyStructureNode{
			{
				Type:    "text",
				Subtype: "plain",
				Params:  map[string]string{"charset": "utf-8"},
				// The CRLF before a boundary delimiter belongs to the
				// delimiter, not to the part, so "here is the report" is 18
				// bytes with no line terminator in it. The Worker's
				// scanToBoundary sets bodyEnd to the index of
				// "\r\n--boundary" for the same reason, which is what
				// keeps the two sides agreeing here.
				Size:     18,
				NumLines: 0,
			},
			{
				Type:        "application",
				Subtype:     "pdf",
				Params:      map[string]string{"name": "report.pdf"},
				ID:          "<att-1@example.com>",
				Description: "quarterly report",
				Encoding:    "base64",
				Size:        12,
				Disposition: &backend.BodyStructureDisposition{
					Value:  "attachment",
					Params: map[string]string{"filename": "report.pdf"},
				},
			},
		},
	}
}

// fetchBodyStructureLine delivers bsMessage into a fresh session, optionally
// with a precomputed structure attached, and returns the BODYSTRUCTURE the
// client sees plus the number of raw fetches it took.
func fetchBodyStructureLine(t *testing.T, stored *backend.BodyStructureNode) (line string, rawFetches int) {
	t.Helper()

	be := newFakeBackend(t)
	c := startRawClient(t, be, WithPollInterval(0))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	uid := be.deliver(t, "inbox", newMessage("report attached", "sender@example.com", time.Now()), bsMessage)
	if stored != nil {
		be.setBodyStructure("inbox", uid, stored)
	}
	requireOK(t, c.do("NOOP")) // let the poll pick the message up

	before := be.rawCallsFor(uid)
	reply := c.do("UID FETCH %d (BODYSTRUCTURE)", uid)
	requireOK(t, reply)
	after := be.rawCallsFor(uid)

	joined := strings.Join(reply, "\n")
	idx := strings.Index(joined, "BODYSTRUCTURE ")
	if idx < 0 {
		t.Fatalf("FETCH = %q, want a BODYSTRUCTURE", reply)
	}
	return strings.TrimSuffix(joined[idx:], ")"), after - before
}

// TestPrecomputedMatchesDerived is the assertion that matters. If the two
// paths disagree, a client sees a different structure depending on when the
// message happened to arrive, and it has no way to notice.
func TestPrecomputedMatchesDerived(t *testing.T) {
	derived, derivedFetches := fetchBodyStructureLine(t, nil)
	decoded, decodedFetches := fetchBodyStructureLine(t, bsMessageStored())

	if derived != decoded {
		t.Fatalf("the two paths disagree over the wire:\nderived: %s\ndecoded: %s", derived, decoded)
	}
	t.Logf("both paths emit: %s", derived)

	if derivedFetches != 1 {
		t.Errorf("deriving from raw took %d fetches, want 1", derivedFetches)
	}
	if decodedFetches != 0 {
		t.Errorf("a precomputed structure took %d raw fetches, want 0", decodedFetches)
	}
}

// TestPrecomputedSkipsTheRawFetch states the optimisation on its own, so a
// regression names itself rather than showing up as a mismatch.
func TestPrecomputedSkipsTheRawFetch(t *testing.T) {
	_, fetches := fetchBodyStructureLine(t, bsMessageStored())
	if fetches != 0 {
		t.Errorf("raw fetches = %d, want 0: the precomputed structure was not used", fetches)
	}
}

// TestFallbackWhenStructureIsUnusable: absent, null and an unrecognised
// version all take the raw path and still produce a correct structure. Most
// of an existing mailbox is in exactly this state, so this is the common
// case rather than an edge.
func TestFallbackWhenStructureIsUnusable(t *testing.T) {
	want, _ := fetchBodyStructureLine(t, nil)

	unknownVersion := bsMessageStored()
	unknownVersion.Version = backend.BodyStructureVersion + 1

	zeroVersion := bsMessageStored()
	zeroVersion.Version = 0 // what a payload with no "v" decodes to

	childlessMultipart := &backend.BodyStructureNode{
		Version: backend.BodyStructureVersion,
		Type:    "multipart",
		Subtype: "mixed",
	}

	tests := map[string]*backend.BodyStructureNode{
		"absent":              nil,
		"unknown version":     unknownVersion,
		"missing version":     zeroVersion,
		"childless multipart": childlessMultipart,
	}

	for name, stored := range tests {
		t.Run(name, func(t *testing.T) {
			got, fetches := fetchBodyStructureLine(t, stored)
			if got != want {
				t.Errorf("fallback structure differs from the derived one:\n got: %s\nwant: %s", got, want)
			}
			if fetches != 1 {
				t.Errorf("raw fetches = %d, want 1: the fallback did not run", fetches)
			}
		})
	}
}

// TestNullBodyStructureDecodesToAbsent covers the wire form specifically:
// the field may be JSON null rather than omitted.
func TestNullBodyStructureDecodesToAbsent(t *testing.T) {
	var msg backend.Message
	if err := json.Unmarshal([]byte(`{"uid":3,"bodyStructure":null}`), &msg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if msg.BodyStructure != nil {
		t.Errorf("BodyStructure = %+v, want nil for a JSON null", msg.BodyStructure)
	}
	if decodeBodyStructure(msg.BodyStructure) != nil {
		t.Error("a null structure decoded to something")
	}
}

// TestStoredJSONFieldNamesMatchTheWorker decodes the payload shape from the
// Worker's own documentation.
//
// Without this, a mistyped json tag would make every structure look absent:
// the fallback would quietly handle it, every other test would still pass,
// and the optimisation would simply never happen.
func TestStoredJSONFieldNamesMatchTheWorker(t *testing.T) {
	const payload = `{"uid":7,"bodyStructure":{"v":1,"type":"multipart","subtype":"mixed",` +
		`"params":{"boundary":"B"},` +
		`"children":[{"type":"text","subtype":"plain","params":{"charset":"utf-8"},` +
		`"size":26,"numLines":1},` +
		`{"type":"application","subtype":"pdf","params":{"name":"report.pdf"},` +
		`"id":"<att-1@example.com>","encoding":"base64","size":12,` +
		`"disposition":{"value":"attachment","params":{"filename":"report.pdf"}}}]}}`

	var msg backend.Message
	if err := json.Unmarshal([]byte(payload), &msg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	node := msg.BodyStructure
	if node == nil {
		t.Fatal("bodyStructure did not decode; a json tag does not match the Worker")
	}
	if node.Version != 1 || node.Type != "multipart" || node.Subtype != "mixed" {
		t.Fatalf("root = %+v", node)
	}
	if node.Params["boundary"] != "B" {
		t.Errorf("root params = %v", node.Params)
	}
	if len(node.Children) != 2 {
		t.Fatalf("children = %d, want 2", len(node.Children))
	}

	text := node.Children[0]
	if text.Type != "text" || text.Subtype != "plain" || text.Size != 26 || text.NumLines != 1 {
		t.Errorf("text child = %+v", text)
	}
	if text.Params["charset"] != "utf-8" {
		t.Errorf("text params = %v", text.Params)
	}

	pdf := node.Children[1]
	if pdf.Type != "application" || pdf.Subtype != "pdf" || pdf.Size != 12 || pdf.Encoding != "base64" {
		t.Errorf("pdf child = %+v", pdf)
	}
	if pdf.ID != "<att-1@example.com>" {
		t.Errorf("pdf id = %q", pdf.ID)
	}
	if pdf.Disposition == nil || pdf.Disposition.Value != "attachment" ||
		pdf.Disposition.Params["filename"] != "report.pdf" {
		t.Errorf("pdf disposition = %+v", pdf.Disposition)
	}

	// And it survives the decode into go-imap's form.
	if decodeBodyStructure(node) == nil {
		t.Error("the documented payload decoded to nothing")
	}
}

// ---------------------------------------------------------------------
// Decoder unit tests: the shapes that panic go-imap's writer
// ---------------------------------------------------------------------

// TestDecodeAllocatesExtendedEverywhere is constraint one. go-imap's
// extended writer dereferences Extended without checking, so a nil on any
// node is a panic in the server rather than an error to a client.
func TestDecodeAllocatesExtendedEverywhere(t *testing.T) {
	decoded := decodeBodyStructure(bsMessageStored())
	if decoded == nil {
		t.Fatal("the fixture did not decode")
	}

	var checked int
	var walk func(imap.BodyStructure)
	walk = func(bs imap.BodyStructure) {
		checked++
		switch node := bs.(type) {
		case *imap.BodyStructureSinglePart:
			if node.Extended == nil {
				t.Errorf("single part %s has a nil Extended", node.MediaType())
			}
		case *imap.BodyStructureMultiPart:
			if node.Extended == nil {
				t.Errorf("multipart %s has a nil Extended", node.MediaType())
			}
			for _, child := range node.Children {
				walk(child)
			}
		default:
			t.Fatalf("unexpected node type %T", bs)
		}
	}
	walk(decoded)

	if checked != 3 {
		t.Errorf("walked %d nodes, want 3", checked)
	}
}

// TestDecodeRejectsShapesTheWriterCannotEmit covers the rest of the
// defensive cases. Each returns nil so the caller falls back, rather than
// producing something the writer would panic on or misencode.
func TestDecodeRejectsShapesTheWriterCannotEmit(t *testing.T) {
	root := func(mutate func(*backend.BodyStructureNode)) *backend.BodyStructureNode {
		n := bsMessageStored()
		mutate(n)
		return n
	}

	tests := map[string]*backend.BodyStructureNode{
		"nil": nil,
		"unknown version": root(func(n *backend.BodyStructureNode) {
			n.Version = 99
		}),
		"childless multipart at the root": {
			Version: backend.BodyStructureVersion, Type: "multipart", Subtype: "mixed",
		},
		"childless multipart nested": root(func(n *backend.BodyStructureNode) {
			n.Children[0] = backend.BodyStructureNode{Type: "multipart", Subtype: "alternative"}
		}),
		"message/rfc822 part": root(func(n *backend.BodyStructureNode) {
			n.Children[0].Type = "message"
			n.Children[0].Subtype = "rfc822"
		}),
		"message/global part": root(func(n *backend.BodyStructureNode) {
			n.Children[0].Type = "message"
			n.Children[0].Subtype = "global"
		}),
		"empty type": root(func(n *backend.BodyStructureNode) {
			n.Children[0].Type = ""
		}),
		"empty subtype": root(func(n *backend.BodyStructureNode) {
			n.Children[0].Subtype = ""
		}),
		"multipart with no subtype": root(func(n *backend.BodyStructureNode) {
			n.Subtype = ""
		}),
	}

	for name, node := range tests {
		t.Run(name, func(t *testing.T) {
			if got := decodeBodyStructure(node); got != nil {
				t.Errorf("decoded to %#v, want nil so the caller falls back", got)
			}
		})
	}
}

// TestDecodeRejectsExcessiveDepth: the Worker bounds nesting before
// storing, but the payload is parsed here and a malformed one must cost
// nothing.
func TestDecodeRejectsExcessiveDepth(t *testing.T) {
	leaf := backend.BodyStructureNode{Type: "text", Subtype: "plain", Size: 1}
	node := leaf
	for i := 0; i < maxBodyStructureDepth+2; i++ {
		node = backend.BodyStructureNode{
			Type: "multipart", Subtype: "mixed",
			Children: []backend.BodyStructureNode{node},
		}
	}
	node.Version = backend.BodyStructureVersion

	if got := decodeBodyStructure(&node); got != nil {
		t.Error("an over-deep structure decoded instead of falling back")
	}
}

func TestDecodeRejectsTooManyParts(t *testing.T) {
	children := make([]backend.BodyStructureNode, maxBodyStructureParts+1)
	for i := range children {
		children[i] = backend.BodyStructureNode{Type: "text", Subtype: "plain", Size: 1}
	}
	node := &backend.BodyStructureNode{
		Version: backend.BodyStructureVersion,
		Type:    "multipart", Subtype: "mixed",
		Children: children,
	}
	if got := decodeBodyStructure(node); got != nil {
		t.Error("a structure with too many parts decoded instead of falling back")
	}
}

// TestDecodeSinglePartMessage covers the non-multipart path, which the
// multipart fixture does not reach at the root.
func TestDecodeSinglePartMessage(t *testing.T) {
	node := &backend.BodyStructureNode{
		Version:  backend.BodyStructureVersion,
		Type:     "text",
		Subtype:  "plain",
		Params:   map[string]string{"charset": "utf-8"},
		Size:     49,
		NumLines: 1,
	}

	decoded := decodeBodyStructure(node)
	part, ok := decoded.(*imap.BodyStructureSinglePart)
	if !ok {
		t.Fatalf("decoded to %T, want a single part", decoded)
	}
	if part.MediaType() != "text/plain" || part.Size != 49 {
		t.Errorf("part = %+v", part)
	}
	if part.Text == nil || part.Text.NumLines != 1 {
		t.Errorf("Text = %+v, want a line count on a text part", part.Text)
	}
	if part.Extended == nil {
		t.Error("Extended is nil")
	}
}

// TestDecodeOmitsLineCountOffNonText: NumLines is an extra field of
// body-type-text in the grammar, so attaching it elsewhere would emit a
// malformed response.
func TestDecodeOmitsLineCountOffNonText(t *testing.T) {
	node := &backend.BodyStructureNode{
		Version: backend.BodyStructureVersion,
		Type:    "application", Subtype: "pdf", Size: 10, NumLines: 7,
	}
	part, ok := decodeBodyStructure(node).(*imap.BodyStructureSinglePart)
	if !ok {
		t.Fatal("did not decode to a single part")
	}
	if part.Text != nil {
		t.Errorf("Text = %+v on an application/pdf part, want nil", part.Text)
	}
}

// TestDecodeTreatsEmptyDispositionAsAbsent: go-imap writes NIL for a nil
// disposition, which is what no Content-Disposition means. A disposition
// with an empty value would emit an empty string instead.
func TestDecodeTreatsEmptyDispositionAsAbsent(t *testing.T) {
	node := &backend.BodyStructureNode{
		Version: backend.BodyStructureVersion,
		Type:    "text", Subtype: "plain", Size: 1,
		Disposition: &backend.BodyStructureDisposition{},
	}
	part := decodeBodyStructure(node).(*imap.BodyStructureSinglePart)
	if part.Extended.Disposition != nil {
		t.Errorf("Disposition = %+v, want nil for an empty value", part.Extended.Disposition)
	}
}
