import QtQuick
import qs.Common
import qs.DCommon.Widgets
import qs.Modules.Plugins
import "GelbooruNet.js" as Net

DashCardComponent {
    id: root

    clickable: true

    readonly property var posts: pluginData.posts ?? []
    readonly property var latest: posts.length > 0 ? posts[0] : null
    readonly property string thumbUrl: latest ? (latest.previewUrl ?? "") : ""

    property var thumbs: ({})

    Component.onCompleted: requestThumb(thumbUrl)
    onThumbUrlChanged: requestThumb(thumbUrl)

    function requestThumb(url) {
        if (!url)
            return
        Net.fetch(url, function(dataUrl) {
            root.store(url, dataUrl)
        })
    }

    function store(url, dataUrl) {
        if (!url || !dataUrl)
            return
        if (thumbs[url] === dataUrl)
            return
        const next = {}
        for (const key in thumbs)
            next[key] = thumbs[key]
        next[url] = dataUrl
        thumbs = next
    }

    Item {
        anchors.fill: parent

        Image {
            visible: root.latest !== null
            anchors.fill: parent
            asynchronous: true
            source: root.thumbs[root.thumbUrl] ?? ""
            fillMode: Image.PreserveAspectCrop
        }

        Column {
            visible: root.latest === null
            anchors.centerIn: parent
            spacing: Theme.spacingS

            DIcon {
                anchors.horizontalCenter: parent.horizontalCenter
                name: "image"
                size: Theme.iconSizeLarge
                color: root.contentColor
            }

            StyledText {
                anchors.horizontalCenter: parent.horizontalCenter
                text: "Gelbooru"
                color: root.contentColor
                font.pixelSize: Theme.fontSizeMedium
            }
        }
    }
}
