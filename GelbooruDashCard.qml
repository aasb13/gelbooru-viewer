import QtQuick
import qs.Common
import qs.DCommon.Widgets
import qs.Modules.Plugins

DashCardComponent {
    id: root

    clickable: true

    readonly property var posts: pluginData.posts ?? []
    readonly property var latest: posts.length > 0 ? posts[0] : null

    Item {
        anchors.fill: parent

        Image {
            visible: root.latest !== null
            anchors.fill: parent
            asynchronous: true
            source: root.latest ? (root.latest.previewUrl ?? "") : ""
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
